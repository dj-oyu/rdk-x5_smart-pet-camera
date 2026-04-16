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
)

var (
	ErrAuthTagMismatch = errors.New("srtp: authentication tag mismatch")
	ErrShortPacket     = errors.New("srtp: packet too short")
)

// AuthTagLen is the SRTP authentication tag length for AES128_CM_HMAC_SHA1_80.
const AuthTagLen = 10

// Cipher performs SRTP encrypt/decrypt for a single direction (local or remote).
//
// Uses software AES-CTR + HMAC-SHA1 (Go crypto). AF_ALG (OP-TEE) was
// implemented and verified correct, but TE context-switch overhead makes
// it slower than software for per-packet SRTP. See docs/optee-afalg-findings.md.
type Cipher struct {
	srtpBlock cipher.Block // AES block cipher for CTR keystream
	srtpSalt  []byte       // 14-byte session salt
	srtpAuth  hash.Hash    // HMAC-SHA1 keyed with session auth key
}

// NewCipher creates an SRTP cipher from pre-derived session keys.
func NewCipher(sessionKey, sessionSalt, sessionAuthKey []byte) (*Cipher, error) {
	block, err := aes.NewCipher(sessionKey)
	if err != nil {
		return nil, err
	}

	auth := hmac.New(sha1.New, sessionAuthKey)

	return &Cipher{
		srtpBlock: block,
		srtpSalt:  sessionSalt,
		srtpAuth:  auth,
	}, nil
}

// Close is a no-op for software crypto (no OS resources to release).
func (c *Cipher) Close() {}

// EncryptRTP encrypts an RTP packet in-place and appends the authentication tag.
// Input: dst must have room for len(rtpPacket) + AuthTagLen bytes.
// rtpPacket = [RTP header (headerLen bytes)] [payload].
// Output: [RTP header] [encrypted payload] [auth tag (10 bytes)].
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

	// Generate authentication tag: HMAC-SHA1(header || encrypted_payload || ROC)
	c.srtpAuth.Reset()
	c.srtpAuth.Write(dst[:headerLen+payloadLen])
	var rocBuf [4]byte
	binary.BigEndian.PutUint32(rocBuf[:], roc)
	c.srtpAuth.Write(rocBuf[:])
	tag := c.srtpAuth.Sum(nil)

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
