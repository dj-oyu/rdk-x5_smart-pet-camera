package srtp

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"os"
)

var (
	ErrAuthTagMismatch = errors.New("srtp: authentication tag mismatch")
	ErrShortPacket     = errors.New("srtp: packet too short")
)

// AuthTagLen is the SRTP authentication tag length for AES128_CM_HMAC_SHA1_80.
const AuthTagLen = 10

// Cipher performs SRTP encrypt/decrypt for a single direction (local or remote).
type Cipher struct {
	srtpBlock cipher.Block      // AES block cipher (fallback for CTR)
	srtpBatch *afalgBatchBlock  // AF_ALG batch ECB (fast CTR keystream)
	srtpSalt  []byte            // 14-byte session salt
	srtpAuth  hash.Hash         // HMAC-SHA1 keyed with session auth key
}

// NewCipher creates an SRTP cipher from pre-derived session keys.
func NewCipher(sessionKey, sessionSalt, sessionAuthKey []byte) (*Cipher, error) {
	// Try AF_ALG batch ECB first (one socket handles both batch and per-block).
	// Only create software AES as fallback — avoid opening two AF_ALG ECB sockets
	// simultaneously (some TE drivers limit concurrent sessions).
	batch := NewAESBatchBlock(sessionKey)

	// Software AES block cipher for per-block ops and CTR fallback.
	// Intentionally using crypto/aes (not AF_ALG) to avoid competing
	// for AF_ALG sockets with the batch ECB above.
	block, err := aes.NewCipher(sessionKey)
	if err != nil {
		if batch != nil {
			batch.Close()
		}
		return nil, err
	}

	auth, err := NewHMACSHA1(sessionAuthKey)
	if err != nil {
		CloseIfNeeded(block)
		if batch != nil {
			batch.Close()
		}
		return nil, err
	}

	if batch != nil {
		fmt.Fprintf(os.Stderr, "[srtp] AF_ALG batch ECB enabled\n")
	} else {
		fmt.Fprintf(os.Stderr, "[srtp] using software AES-CTR (AF_ALG batch unavailable)\n")
	}

	return &Cipher{
		srtpBlock: block,
		srtpBatch: batch,
		srtpSalt:  sessionSalt,
		srtpAuth:  auth,
	}, nil
}

// Close releases AF_ALG resources if applicable.
func (c *Cipher) Close() {
	CloseIfNeeded(c.srtpBlock)
	CloseIfNeeded(c.srtpAuth)
	if c.srtpBatch != nil {
		c.srtpBatch.Close()
	}
}

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
	usedBatch := false
	if c.srtpBatch != nil {
		usedBatch = xorBytesCTRBatch(c.srtpBatch, counter[:], dst[headerLen:headerLen+payloadLen], rtpPacket[headerLen:])
	}
	if !usedBatch {
		xorBytesCTR(c.srtpBlock, counter[:], dst[headerLen:headerLen+payloadLen], rtpPacket[headerLen:])
	}

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

// xorBytesCTRBatch uses AF_ALG batch ECB to generate CTR keystream in one syscall.
// Returns false if AF_ALG fails (caller should fallback to software).
func xorBytesCTRBatch(batch *afalgBatchBlock, iv []byte, dst, src []byte) bool {
	bs := 16
	nBlocks := (len(src) + bs - 1) / bs

	// Build counter blocks
	counters := make([]byte, nBlocks*bs)
	ctr := make([]byte, bs)
	copy(ctr, iv)
	for i := 0; i < nBlocks; i++ {
		copy(counters[i*bs:], ctr)
		incrementCTR(ctr)
	}

	// Encrypt all counter blocks in one syscall → keystream
	keystream := make([]byte, nBlocks*bs)
	if err := batch.EncryptBlocks(keystream, counters); err != nil {
		return false
	}

	// XOR keystream with plaintext
	subtle.XORBytes(dst[:len(src)], src, keystream[:len(src)])
	return true
}

// xorBytesCTR encrypts src into dst using AES-CTR with the given IV (software fallback).
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
