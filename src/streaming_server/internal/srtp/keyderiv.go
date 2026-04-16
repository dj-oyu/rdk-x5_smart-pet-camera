package srtp

import (
	"crypto/cipher"
	"encoding/binary"
)

// SRTP key derivation labels (RFC 3711 Section 4.3.1).
const (
	LabelSRTPEncryption  byte = 0x00
	LabelSRTPAuthTag     byte = 0x01
	LabelSRTPSalt        byte = 0x02
	LabelSRTCPEncryption byte = 0x03
	LabelSRTCPAuthTag    byte = 0x04
	LabelSRTCPSalt       byte = 0x05
)

// AesCmKeyDerivation derives a session key from the master key and salt
// using AES-CM PRF as specified in RFC 3711 Appendix B.3.
//
//	label: one of Label* constants
//	masterKey: 16 or 32 bytes
//	masterSalt: 14 bytes (AES-CM profiles)
//	outLen: desired output length in bytes
func AesCmKeyDerivation(block cipher.Block, label byte, masterSalt []byte, outLen int) ([]byte, error) {
	blockSize := block.BlockSize() // always 16 for AES

	// Build PRF input: masterSalt with label XOR'd at byte 7.
	// prfIn is 16 bytes: [salt(14) | 0x00 0x00], then label XOR at index 7.
	var prfIn [16]byte
	copy(prfIn[:], masterSalt)
	prfIn[7] ^= label

	out := make([]byte, ((outLen+blockSize-1)/blockSize)*blockSize)

	for i := 0; i < len(out)/blockSize; i++ {
		// Set counter in last 2 bytes (big-endian)
		binary.BigEndian.PutUint16(prfIn[14:16], uint16(i))
		block.Encrypt(out[i*blockSize:], prfIn[:])
	}

	return out[:outLen], nil
}

// GenerateCounter builds the 16-byte AES-CTR IV for SRTP encryption.
// RFC 3711 Section 4.1.1:
//
//	IV = (sessionSalt XOR (SSRC || ROC || SEQ)) << 16
func GenerateCounter(sequenceNumber uint16, rolloverCounter uint32, ssrc uint32, sessionSalt []byte) [16]byte {
	var counter [16]byte
	copy(counter[:], sessionSalt)

	// XOR SSRC at bytes 4-7
	counter[4] ^= byte(ssrc >> 24)
	counter[5] ^= byte(ssrc >> 16)
	counter[6] ^= byte(ssrc >> 8)
	counter[7] ^= byte(ssrc)

	// XOR ROC (rollover counter) at bytes 8-11
	counter[8] ^= byte(rolloverCounter >> 24)
	counter[9] ^= byte(rolloverCounter >> 16)
	counter[10] ^= byte(rolloverCounter >> 8)
	counter[11] ^= byte(rolloverCounter)

	// XOR sequence number at bytes 12-13
	counter[12] ^= byte(sequenceNumber >> 8)
	counter[13] ^= byte(sequenceNumber)

	return counter
}
