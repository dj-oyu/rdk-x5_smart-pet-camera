package srtp

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"hash"
	"sync"
)

var (
	ErrAuthTagMismatch = errors.New("srtp: authentication tag mismatch")
	ErrShortPacket     = errors.New("srtp: packet too short")
)

// AuthTagLen is the SRTP authentication tag length for AES128_CM_HMAC_SHA1_80.
const AuthTagLen = 10

// Cipher performs SRTP encrypt/decrypt for a single direction (local or remote).
//
// The exported surface is immutable after construction: all fields are set
// once in NewCipher and never written again. EncryptRTP is safe for
// concurrent use — the internal authPool amortizes HMAC instance creation
// without exposing shared mutable state.
//
// Uses software AES-CTR + HMAC-SHA1 (Go crypto). AF_ALG (OP-TEE) was
// implemented and verified correct, but TE context-switch overhead makes
// it slower than software for per-packet SRTP. See docs/optee-afalg-findings.md.
type Cipher struct {
	srtpBlock cipher.Block // AES block cipher for CTR keystream (stateless, concurrent-safe)
	srtpSalt  []byte       // 14-byte session salt (immutable)
	authPool  sync.Pool    // pool of keyed HMAC-SHA1 hashes
}

// NewCipher creates an SRTP cipher from pre-derived session keys.
//
// Returned *Cipher is safe for concurrent use. The session keys are captured
// once; callers may discard their references after construction.
func NewCipher(sessionKey, sessionSalt, sessionAuthKey []byte) (*Cipher, error) {
	block, err := aes.NewCipher(sessionKey)
	if err != nil {
		return nil, err
	}

	// Defensive copy of the auth key: the pool factory captures it and
	// callers may mutate or reuse the input slice after this returns.
	keyCopy := make([]byte, len(sessionAuthKey))
	copy(keyCopy, sessionAuthKey)

	c := &Cipher{
		srtpBlock: block,
		srtpSalt:  sessionSalt,
	}
	c.authPool.New = func() interface{} {
		return hmac.New(sha1.New, keyCopy)
	}

	return c, nil
}

// EncryptRTP encrypts an RTP packet and appends the authentication tag.
// Input: dst must have room for len(rtpPacket) + AuthTagLen bytes; a new
// slice is allocated if capacity is insufficient.
// rtpPacket = [RTP header (headerLen bytes)] [payload].
// Output: [RTP header] [encrypted payload] [auth tag (10 bytes)].
//
// Safe for concurrent use.
func (c *Cipher) EncryptRTP(dst []byte, rtpPacket []byte, headerLen int, seq uint16, roc uint32, ssrc uint32) ([]byte, error) {
	payloadLen := len(rtpPacket) - headerLen
	totalLen := len(rtpPacket) + AuthTagLen

	// Ensure dst has capacity
	if cap(dst) < totalLen {
		dst = make([]byte, totalLen)
	} else {
		dst = dst[:totalLen]
	}

	// Copy header (unencrypted)
	copy(dst[:headerLen], rtpPacket[:headerLen])

	// Encrypt payload with AES-CTR
	counter := GenerateCounter(seq, roc, ssrc, c.srtpSalt)
	xorBytesCTR(c.srtpBlock, counter[:], dst[headerLen:headerLen+payloadLen], rtpPacket[headerLen:])

	// Generate authentication tag: HMAC-SHA1(header || encrypted_payload || ROC).
	// Pool an already-keyed HMAC so repeated calls avoid hmac.New allocations
	// and use the stdlib's marshaled-state fast path in Reset().
	auth := c.authPool.Get().(hash.Hash)
	auth.Reset()
	auth.Write(dst[:headerLen+payloadLen])
	var rocBuf [4]byte
	binary.BigEndian.PutUint32(rocBuf[:], roc)
	auth.Write(rocBuf[:])
	tag := auth.Sum(nil)
	c.authPool.Put(auth)

	// Append truncated tag
	copy(dst[headerLen+payloadLen:], tag[:AuthTagLen])

	return dst[:totalLen], nil
}

// ----- AES-CTR XOR (same algorithm as pion/srtp crypto.go) -----

// xorBytesCTR encrypts src into dst using AES-CTR with the given IV.
func xorBytesCTR(block cipher.Block, iv []byte, dst, src []byte) {
	bs := block.BlockSize()
	ctr := make([]byte, bs)
	copy(ctr, iv)
	stream := make([]byte, bs)

	for i := 0; i < len(src); {
		block.Encrypt(stream, ctr)
		incrementCTR(ctr)
		n := len(src) - i
		if n > bs {
			n = bs
		}
		subtle.XORBytes(dst[i:i+n], src[i:i+n], stream[:n])
		i += n
	}
}

// incrementCTR increments a big-endian counter by 1.
func incrementCTR(ctr []byte) {
	for i := len(ctr) - 1; i >= 0; i-- {
		ctr[i]++
		if ctr[i] != 0 {
			break
		}
	}
}
