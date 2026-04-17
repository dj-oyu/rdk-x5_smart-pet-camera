package srtp

import (
	"bytes"
	"sync"
	"sync/atomic"
	"testing"
)

// TestCipher_ConcurrentEncryptRTP verifies that concurrent EncryptRTP calls
// on a single *Cipher produce correct output. Run with -race to detect any
// hidden shared mutable state.
func TestCipher_ConcurrentEncryptRTP(t *testing.T) {
	sessionKey := mustHex("2B7E151628AED2A6ABF7158809CF4F3C")
	sessionSalt := mustHex("F0F1F2F3F4F5F6F7F8F9FAFBFCFD")
	sessionAuthKey := mustHex("CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4")

	c, err := NewCipher(sessionKey, sessionSalt, sessionAuthKey)
	if err != nil {
		t.Fatal(err)
	}

	// Reference: encrypt a single well-known packet serially.
	packet := mustHex("800F1234DECAFBADDEADBEEFABABABABABABABABABABABABABABABABAB")
	headerLen := 12
	seq := uint16(0x1234)
	roc := uint32(0)
	ssrc := uint32(0xDEADBEEF)

	want, err := c.EncryptRTP(make([]byte, 0), packet, headerLen, seq, roc, ssrc)
	if err != nil {
		t.Fatal(err)
	}
	wantCopy := append([]byte(nil), want...)

	// Fire off many goroutines encrypting the same packet with the same
	// (seq, roc, ssrc). With concurrency-unsafe shared state (e.g. a
	// shared hash.Hash), output would occasionally differ.
	const workers = 16
	const iters = 500

	var wg sync.WaitGroup
	var mismatches atomic.Int64

	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func() {
			defer wg.Done()
			buf := make([]byte, 0, len(wantCopy))
			for i := 0; i < iters; i++ {
				got, err := c.EncryptRTP(buf, packet, headerLen, seq, roc, ssrc)
				if err != nil {
					t.Errorf("EncryptRTP: %v", err)
					return
				}
				if !bytes.Equal(got, wantCopy) {
					mismatches.Add(1)
				}
			}
		}()
	}
	wg.Wait()

	if m := mismatches.Load(); m != 0 {
		t.Errorf("concurrent EncryptRTP produced %d mismatching outputs (indicates data race in Cipher)", m)
	}
}

// TestContext_ConcurrentEncryptDifferentSSRC exercises per-SSRC ROC state
// under concurrent access. Different SSRCs do not share ROC entries, so
// results from parallel streams should match a serial reference run.
func TestContext_ConcurrentEncryptDifferentSSRC(t *testing.T) {
	masterKey := mustHex("E1F97A0D3E018BE0D64FA32C06DE4139")
	masterSalt := mustHex("0EC675AD498AFEEBB6960B3AABE6")

	ctx, err := NewContext(masterKey, masterSalt)
	if err != nil {
		t.Fatal(err)
	}

	packet := mustHex("800F1234DECAFBADDEADBEEFABABABABABABABABABABABABABABABABAB")
	headerLen := 12
	seq := uint16(0x1234)

	const ssrcCount = 8
	ssrcs := make([]uint32, ssrcCount)
	for i := range ssrcs {
		ssrcs[i] = 0xAA000000 | uint32(i)
	}

	// Reference: encrypt each SSRC serially.
	wantByIdx := make([][]byte, ssrcCount)
	for i, ssrc := range ssrcs {
		out, err := ctx.EncryptRTP(make([]byte, 0), packet, headerLen, seq, ssrc)
		if err != nil {
			t.Fatal(err)
		}
		wantByIdx[i] = append([]byte(nil), out...)
	}

	// Fresh context so ROC state starts clean.
	ctx2, err := NewContext(masterKey, masterSalt)
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	var mismatches atomic.Int64
	wg.Add(ssrcCount)
	for i, ssrc := range ssrcs {
		go func(idx int, ssrc uint32) {
			defer wg.Done()
			got, err := ctx2.EncryptRTP(make([]byte, 0), packet, headerLen, seq, ssrc)
			if err != nil {
				t.Errorf("ssrc %x: %v", ssrc, err)
				return
			}
			if !bytes.Equal(got, wantByIdx[idx]) {
				mismatches.Add(1)
			}
		}(i, ssrc)
	}
	wg.Wait()

	if m := mismatches.Load(); m != 0 {
		t.Errorf("concurrent per-SSRC encryption produced %d mismatches", m)
	}
}

// TestCipher_ReentrantAfterKeyBufferMutation guards against callers mutating
// their copy of sessionAuthKey after NewCipher returns. The Cipher must
// defensively copy the key bytes.
func TestCipher_ReentrantAfterKeyBufferMutation(t *testing.T) {
	sessionKey := mustHex("2B7E151628AED2A6ABF7158809CF4F3C")
	sessionSalt := mustHex("F0F1F2F3F4F5F6F7F8F9FAFBFCFD")
	authKey := mustHex("CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4")

	// Snapshot BEFORE constructing cipher.
	authKeyCopy := append([]byte(nil), authKey...)

	c, err := NewCipher(sessionKey, sessionSalt, authKey)
	if err != nil {
		t.Fatal(err)
	}
	// Reference cipher built from the pristine copy.
	cRef, err := NewCipher(sessionKey, sessionSalt, authKeyCopy)
	if err != nil {
		t.Fatal(err)
	}

	// Mutate the caller's slice AFTER construction — this must not affect
	// authentication tags produced by c.
	for i := range authKey {
		authKey[i] ^= 0xFF
	}

	packet := mustHex("800F1234DECAFBADDEADBEEFABABABABABABABABABABABABABABABABAB")
	got, err := c.EncryptRTP(make([]byte, 0), packet, 12, 0x1234, 0, 0xDEADBEEF)
	if err != nil {
		t.Fatal(err)
	}
	want, err := cRef.EncryptRTP(make([]byte, 0), packet, 12, 0x1234, 0, 0xDEADBEEF)
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(got, want) {
		t.Error("Cipher did not defensively copy the auth key — mutation of caller's slice altered output")
	}
}
