package srtp

import (
	"bytes"
	"crypto/aes"
	"encoding/hex"
	"testing"
)

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// TestKeyDerivation_AES128 tests AES-CM 128-bit key derivation
// using the test vector from pion/srtp key_derivation_test.go (RFC 3711).
func TestKeyDerivation_AES128(t *testing.T) {
	masterKey := mustHex("E1F97A0D3E018BE0D64FA32C06DE4139")
	masterSalt := mustHex("0EC675AD498AFEEBB6960B3AABE6")

	block, err := aes.NewCipher(masterKey)
	if err != nil {
		t.Fatal(err)
	}

	// Session encryption key (label=0x00)
	sessionKey, err := AesCmKeyDerivation(block, LabelSRTPEncryption, masterSalt, 16)
	if err != nil {
		t.Fatal(err)
	}
	expected := mustHex("C61E7A93744F39EE10734AFE3FF7A087")
	if !bytes.Equal(sessionKey, expected) {
		t.Errorf("session key:\n  got  %x\n  want %x", sessionKey, expected)
	}

	// Session salt (label=0x02)
	sessionSalt, err := AesCmKeyDerivation(block, LabelSRTPSalt, masterSalt, 14)
	if err != nil {
		t.Fatal(err)
	}
	expectedSalt := mustHex("30CBBC08863D8C85D49DB34A9AE1")
	if !bytes.Equal(sessionSalt, expectedSalt) {
		t.Errorf("session salt:\n  got  %x\n  want %x", sessionSalt, expectedSalt)
	}

	// Session auth key (label=0x01)
	sessionAuth, err := AesCmKeyDerivation(block, LabelSRTPAuthTag, masterSalt, 20)
	if err != nil {
		t.Fatal(err)
	}
	expectedAuth := mustHex("CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4")
	if !bytes.Equal(sessionAuth, expectedAuth) {
		t.Errorf("session auth:\n  got  %x\n  want %x", sessionAuth, expectedAuth)
	}
}

// TestGenerateCounter tests IV generation using the test vector from pion/srtp srtp_test.go.
func TestGenerateCounter(t *testing.T) {
	masterKey := mustHex("0DCD213E4CBCF28F017F6994401E2889")
	masterSalt := mustHex("62776038C06DC9419F6DD9433E7C")

	block, err := aes.NewCipher(masterKey)
	if err != nil {
		t.Fatal(err)
	}

	sessionSalt, err := AesCmKeyDerivation(block, LabelSRTPSalt, masterSalt, 14)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("sessionSalt: %x", sessionSalt)

	seq := uint16(0x804E)      // 32846
	roc := uint32(0)
	ssrc := uint32(0xF7B4DFDE) // 4160032510

	counter := GenerateCounter(seq, roc, ssrc, sessionSalt)
	expected := mustHex("CF901EA5DA92FD3500A224AEAEAF0000")

	if !bytes.Equal(counter[:], expected) {
		t.Errorf("counter:\n  got  %x\n  want %x", counter[:], expected)
	}
}

// TestXorBytesCTR tests AES-CTR XOR using RFC 3711 Appendix B.2 test vector.
func TestXorBytesCTR_RFC3711(t *testing.T) {
	sessionKey := mustHex("2B7E151628AED2A6ABF7158809CF4F3C")
	sessionSalt := mustHex("F0F1F2F3F4F5F6F7F8F9FAFBFCFD0000")

	block, err := aes.NewCipher(sessionKey)
	if err != nil {
		t.Fatal(err)
	}

	// Generate keystream by XOR'ing with zeros
	zeros := make([]byte, 48)
	dst := make([]byte, 48)
	xorBytesCTR(block, sessionSalt, dst, zeros)

	expected := mustHex(
		"E03EAD0935C95E80E166B16DD92B4EB4" +
			"D23513162B02D0F72A43A2FE4A5F97AB" +
			"41E95B3BB0A2E8DD477901E4FCA894C0")

	if !bytes.Equal(dst, expected) {
		t.Errorf("keystream:\n  got  %x\n  want %x", dst, expected)
	}
}

// TestEncryptRTP tests full SRTP encryption with pion/srtp test data.
func TestEncryptRTP(t *testing.T) {
	masterKey := mustHex("E1F97A0D3E018BE0D64FA32C06DE4139")
	masterSalt := mustHex("0EC675AD498AFEEBB6960B3AABE6")

	ctx, err := NewContext(masterKey, masterSalt)
	if err != nil {
		t.Fatal(err)
	}
	defer ctx.Close()

	decryptedPacket := mustHex(
		"800F1234DECAFBAD" +
			"DEADBEEF" +
			"ABABABABABABABABABABABABABABABAB")

	headerLen := 12
	seq := uint16(0x1234)
	ssrc := uint32(0xDEADBEEF)

	dst := make([]byte, len(decryptedPacket)+AuthTagLen)
	encrypted, err := ctx.EncryptRTP(dst, decryptedPacket, headerLen, seq, ssrc)
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(encrypted[:headerLen], decryptedPacket[:headerLen]) {
		t.Error("header was modified during encryption")
	}
	if bytes.Equal(encrypted[headerLen:headerLen+15], decryptedPacket[headerLen:]) {
		t.Error("payload was not encrypted")
	}
	if len(encrypted) != len(decryptedPacket)+AuthTagLen {
		t.Errorf("length: got %d, want %d", len(encrypted), len(decryptedPacket)+AuthTagLen)
	}

	t.Logf("encrypted: %x", encrypted)
}

// TestNewContext_DeriveKeys verifies that NewContext correctly derives session keys.
func TestNewContext_DeriveKeys(t *testing.T) {
	masterKey := mustHex("E1F97A0D3E018BE0D64FA32C06DE4139")
	masterSalt := mustHex("0EC675AD498AFEEBB6960B3AABE6")

	sessionKey, sessionSalt, sessionAuth, err := DeriveSessionKeys(masterKey, masterSalt)
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(sessionKey, mustHex("C61E7A93744F39EE10734AFE3FF7A087")) {
		t.Errorf("session key mismatch: %x", sessionKey)
	}
	if !bytes.Equal(sessionSalt, mustHex("30CBBC08863D8C85D49DB34A9AE1")) {
		t.Errorf("session salt mismatch: %x", sessionSalt)
	}
	if !bytes.Equal(sessionAuth, mustHex("CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4")) {
		t.Errorf("session auth mismatch: %x", sessionAuth)
	}
}

// TestAFALGBatchECB verifies AF_ALG batch ECB produces the same CTR keystream
// as Go software AES. This is a reference test for the AF_ALG implementation
// (afalg.go), not used in the production SRTP hot path.
func TestAFALGBatchECB(t *testing.T) {
	sessionKey := mustHex("2B7E151628AED2A6ABF7158809CF4F3C")
	iv := mustHex("F0F1F2F3F4F5F6F7F8F9FAFBFCFD0000")

	goBlock, err := aes.NewCipher(sessionKey)
	if err != nil {
		t.Fatal(err)
	}
	zeros := make([]byte, 48)
	goDst := make([]byte, 48)
	xorBytesCTR(goBlock, iv, goDst, zeros)

	batch := NewAESBatchBlock(sessionKey)
	if batch == nil {
		t.Skip("AF_ALG batch ECB not available")
	}
	defer batch.Close()

	// Build counter blocks and encrypt via AF_ALG
	bs := 16
	nBlocks := len(zeros) / bs
	counters := make([]byte, nBlocks*bs)
	ctr := make([]byte, bs)
	copy(ctr, iv)
	for i := 0; i < nBlocks; i++ {
		copy(counters[i*bs:], ctr)
		incrementCTR(ctr)
	}
	keystream := make([]byte, nBlocks*bs)
	if err := batch.EncryptBlocks(keystream, counters); err != nil {
		t.Fatal("AF_ALG batch ECB failed:", err)
	}

	if !bytes.Equal(goDst, keystream) {
		t.Errorf("AF_ALG batch ECB mismatch:\n  Go:     %x\n  AF_ALG: %x", goDst, keystream)
	}
	t.Logf("AF_ALG batch ECB: OK (available: %v)", afalgAvailable())
}

// BenchmarkEncryptRTP benchmarks SRTP encryption for a typical H.265 frame.
func BenchmarkEncryptRTP(b *testing.B) {
	masterKey := mustHex("E1F97A0D3E018BE0D64FA32C06DE4139")
	masterSalt := mustHex("0EC675AD498AFEEBB6960B3AABE6")

	ctx, err := NewContext(masterKey, masterSalt)
	if err != nil {
		b.Fatal(err)
	}
	defer ctx.Close()

	packet := make([]byte, 1200)
	packet[0] = 0x80
	packet[1] = 0x60
	dst := make([]byte, 1200+AuthTagLen)

	b.ResetTimer()
	b.SetBytes(1200)

	for i := 0; i < b.N; i++ {
		seq := uint16(i)
		packet[2] = byte(seq >> 8)
		packet[3] = byte(seq)
		ctx.EncryptRTP(dst, packet, 12, seq, 0x12345678)
	}
}
