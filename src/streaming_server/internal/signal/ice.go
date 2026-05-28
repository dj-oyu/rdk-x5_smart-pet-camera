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
	stunAttrUsername         = 0x0006
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
	localUfrag  string
	localPwd    string
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

	// Authenticate the request before answering. Without this any host on
	// the path could forge a Binding Request and hijack the ICE check
	// (RFC 8445 §7.3). 認証に失敗したら無応答 (silently drop)。
	if !ice.validateRequestAuth(data) {
		return nil
	}

	// Extract transaction ID (bytes 8-20)
	var txnID [12]byte
	copy(txnID[:], data[8:20])

	// Build Binding Response
	return ice.buildBindingResponse(txnID, remoteAddr)
}

// validateRequestAuth verifies the short-term credentials on an inbound STUN
// Binding Request (RFC 8445 §7.3 / RFC 5389 §10.1.2):
//   - USERNAME must equal localUfrag:remoteUfrag (== STUNUsername()).
//   - MESSAGE-INTEGRITY must be HMAC-SHA1(localPwd) over the message up to
//     (but not including) the MI attribute, with the STUN length field fixed
//     up to cover MI — same technique as ValidateBindingResponse.
//
// USERNAME か MESSAGE-INTEGRITY が欠落/不一致なら false を返す。
func (ice *ICELite) validateRequestAuth(data []byte) bool {
	// Walk attributes, recording USERNAME value and the MI attribute offset.
	var username []byte
	miOffset := -1 // start of MESSAGE-INTEGRITY attribute (incl. type/len)
	offset := stunHeaderSize
	for offset+4 <= len(data) {
		attrType := binary.BigEndian.Uint16(data[offset : offset+2])
		attrLen := int(binary.BigEndian.Uint16(data[offset+2 : offset+4]))
		valStart := offset + 4
		valEnd := valStart + attrLen
		if valEnd > len(data) {
			return false
		}
		switch attrType {
		case stunAttrUsername:
			username = data[valStart:valEnd]
		case stunAttrMessageIntegrity:
			miOffset = offset
		}
		// Pad to 4-byte boundary.
		if pad := attrLen % 4; pad != 0 {
			valEnd += 4 - pad
		}
		offset = valEnd
	}

	// USERNAME must match localUfrag:remoteUfrag exactly.
	if username == nil || string(username) != ice.STUNUsername() {
		return false
	}

	// MESSAGE-INTEGRITY must be present and valid under localPwd.
	if miOffset < 0 || miOffset+4+20 > len(data) {
		return false
	}
	miLen := miOffset - stunHeaderSize + 24
	miSnapshot := make([]byte, miOffset)
	copy(miSnapshot, data[:miOffset])
	binary.BigEndian.PutUint16(miSnapshot[2:4], uint16(miLen))
	mac := hmac.New(sha1.New, []byte(ice.localPwd))
	mac.Write(miSnapshot)
	wantMI := mac.Sum(nil)
	gotMI := data[miOffset+4 : miOffset+4+20]
	return hmac.Equal(wantMI, gotMI)
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
		// IPv6: family + xor-port + xor-address(16). XOR key for the address
		// is magic-cookie || txn-id (RFC 5389 §15.2).
		ip := addr.IP.To16()
		buf := make([]byte, 4+16)
		buf[0] = 0
		buf[1] = 0x02 // Family: IPv6
		binary.BigEndian.PutUint16(buf[2:4], uint16(addr.Port)^uint16(stunMagicCookie>>16))
		var xorKey [16]byte
		binary.BigEndian.PutUint32(xorKey[0:4], stunMagicCookie)
		copy(xorKey[4:], txnID[:])
		for i := 0; i < 16; i++ {
			buf[4+i] = ip[i] ^ xorKey[i]
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
