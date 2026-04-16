package signal

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/binary"
	"fmt"
	"net"
)

// STUN message types (RFC 5389)
const (
	stunBindingRequest  = 0x0001
	stunBindingResponse = 0x0101

	stunAttrMappedAddress    = 0x0001
	stunAttrXORMappedAddress = 0x0020
	stunAttrUsername          = 0x0006
	stunAttrMessageIntegrity = 0x0008
	stunAttrFingerprint      = 0x8028
	stunAttrUseCandidate     = 0x0025
	stunAttrICEControlling   = 0x802A
	stunAttrICEControlled    = 0x8029
	stunAttrPriority         = 0x0024

	stunMagicCookie = 0x2112A442
	stunHeaderSize  = 20
)

// ICELite handles ICE-lite connectivity checks on a UDP socket.
// It responds to STUN Binding Requests with Binding Responses.
type ICELite struct {
	localUfrag string
	localPwd   string
	remoteUfrag string
	remotePwd   string
}

// NewICELite creates an ICE-lite handler.
func NewICELite(localUfrag, localPwd, remoteUfrag, remotePwd string) *ICELite {
	return &ICELite{
		localUfrag:  localUfrag,
		localPwd:    localPwd,
		remoteUfrag: remoteUfrag,
		remotePwd:   remotePwd,
	}
}

// IsSTUN checks if a packet is a STUN message (first byte 0x00 or 0x01).
func IsSTUN(data []byte) bool {
	if len(data) < stunHeaderSize {
		return false
	}
	// STUN messages have the magic cookie at bytes 4-7
	return binary.BigEndian.Uint32(data[4:8]) == stunMagicCookie
}

// HandleSTUN processes a STUN Binding Request and returns a Binding Response.
// Returns nil if the packet is not a valid binding request.
func (ice *ICELite) HandleSTUN(data []byte, remoteAddr *net.UDPAddr) []byte {
	if len(data) < stunHeaderSize {
		return nil
	}

	msgType := binary.BigEndian.Uint16(data[0:2])
	if msgType != stunBindingRequest {
		return nil
	}

	// Extract transaction ID (bytes 8-20)
	var txnID [12]byte
	copy(txnID[:], data[8:20])

	// Build Binding Response
	return ice.buildBindingResponse(txnID, remoteAddr)
}

// buildBindingResponse creates a STUN Binding Response with:
// - XOR-MAPPED-ADDRESS
// - MESSAGE-INTEGRITY (HMAC-SHA1 with local ICE pwd)
// - FINGERPRINT (CRC32 XOR 0x5354554E)
func (ice *ICELite) buildBindingResponse(txnID [12]byte, addr *net.UDPAddr) []byte {
	// Start with header placeholder (will fill length later)
	buf := make([]byte, 0, 128)
	buf = append(buf, 0, 0, 0, 0) // type + length placeholder
	buf = binary.BigEndian.AppendUint32(buf, stunMagicCookie)
	buf = append(buf, txnID[:]...)

	// XOR-MAPPED-ADDRESS attribute
	xorAddr := buildXORMappedAddress(addr, txnID)
	buf = appendAttribute(buf, stunAttrXORMappedAddress, xorAddr)

	// Set message type and length (before MESSAGE-INTEGRITY)
	binary.BigEndian.PutUint16(buf[0:2], stunBindingResponse)

	// MESSAGE-INTEGRITY: HMAC-SHA1 over message up to (but not including) this attribute
	// Length field must include MESSAGE-INTEGRITY (24 bytes: 4 header + 20 HMAC)
	miLenOffset := len(buf) - stunHeaderSize + 24 // length field includes MI
	binary.BigEndian.PutUint16(buf[2:4], uint16(miLenOffset))

	mac := hmac.New(sha1.New, []byte(ice.localPwd))
	mac.Write(buf)
	integrity := mac.Sum(nil)
	buf = appendAttribute(buf, stunAttrMessageIntegrity, integrity)

	// FINGERPRINT: CRC32 XOR 0x5354554E
	// Length field must include FINGERPRINT (8 bytes: 4 header + 4 CRC)
	fpLenOffset := len(buf) - stunHeaderSize + 8
	binary.BigEndian.PutUint16(buf[2:4], uint16(fpLenOffset))

	crc := crc32STUN(buf)
	fpBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(fpBuf, crc^0x5354554E)
	buf = appendAttribute(buf, stunAttrFingerprint, fpBuf)

	// Final length (excluding 20-byte header)
	binary.BigEndian.PutUint16(buf[2:4], uint16(len(buf)-stunHeaderSize))

	return buf
}

// buildXORMappedAddress creates an XOR-MAPPED-ADDRESS attribute value.
func buildXORMappedAddress(addr *net.UDPAddr, txnID [12]byte) []byte {
	ip4 := addr.IP.To4()
	if ip4 == nil {
		// IPv6 - simplified, XOR with magic cookie + txn ID
		buf := []byte{0, 0x02} // Family: IPv6
		binary.BigEndian.AppendUint16(buf, uint16(addr.Port)^uint16(stunMagicCookie>>16))
		ip := addr.IP.To16()
		xorKey := make([]byte, 16)
		binary.BigEndian.PutUint32(xorKey[0:4], stunMagicCookie)
		copy(xorKey[4:], txnID[:])
		for i := range ip {
			buf = append(buf, ip[i]^xorKey[i])
		}
		return buf
	}

	// IPv4
	buf := make([]byte, 8)
	buf[0] = 0    // Reserved
	buf[1] = 0x01 // Family: IPv4
	binary.BigEndian.PutUint16(buf[2:4], uint16(addr.Port)^uint16(stunMagicCookie>>16))
	xorIP := binary.BigEndian.Uint32(ip4) ^ stunMagicCookie
	binary.BigEndian.PutUint32(buf[4:8], xorIP)
	return buf
}

func appendAttribute(buf []byte, attrType uint16, value []byte) []byte {
	buf = binary.BigEndian.AppendUint16(buf, attrType)
	buf = binary.BigEndian.AppendUint16(buf, uint16(len(value)))
	buf = append(buf, value...)
	// Pad to 4-byte boundary
	if pad := len(value) % 4; pad != 0 {
		buf = append(buf, make([]byte, 4-pad)...)
	}
	return buf
}

// crc32STUN computes CRC-32 for STUN FINGERPRINT (ISO 3309 / ITU-T V.42).
func crc32STUN(data []byte) uint32 {
	// Standard CRC-32 (same as zlib)
	var crc uint32 = 0xFFFFFFFF
	for _, b := range data {
		crc ^= uint32(b)
		for i := 0; i < 8; i++ {
			if crc&1 != 0 {
				crc = (crc >> 1) ^ 0xEDB88320
			} else {
				crc >>= 1
			}
		}
	}
	return ^crc
}

// STUNUsername returns the expected username for ICE connectivity checks.
// Format: "local_ufrag:remote_ufrag" (RFC 8445).
func (ice *ICELite) STUNUsername() string {
	return fmt.Sprintf("%s:%s", ice.localUfrag, ice.remoteUfrag)
}
