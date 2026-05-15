package signal

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/binary"
	"fmt"
	"net"
)

// STUN class bits for the message type (RFC 5389 §6).
const (
	stunBindingErrorResponse = 0x0111
)

// BindingRequest carries the inputs needed to build one outgoing STUN
// Binding Request for an ICE connectivity check.
//
// The peer (browser) authenticates the request with `RemotePwd`, so that
// is the key fed into MESSAGE-INTEGRITY (RFC 8445 §7.2.2). The matching
// response is signed by the peer with the same password — see ValidateBindingResponse.
type BindingRequest struct {
	TxnID       [12]byte
	LocalUfrag  string // server side
	RemoteUfrag string // browser side
	RemotePwd   string // browser's ice-pwd, used for MESSAGE-INTEGRITY
	Priority    uint32 // priority of our (server's) local candidate
	// Tiebreaker selects the controller when both sides claim ICE-CONTROLLING.
	// For pet-camera the browser is always the controller, so we always send
	// ICE-CONTROLLED. We still emit a tiebreaker per RFC 8445 §16.1.
	Tiebreaker uint64
}

// NewTransactionID returns a fresh 96-bit STUN transaction ID.
func NewTransactionID() [12]byte {
	var t [12]byte
	_, _ = rand.Read(t[:])
	return t
}

// BuildBindingRequest serialises one STUN Binding Request with the
// attributes required for an ICE connectivity check from a controlled
// agent: USERNAME, ICE-CONTROLLED, PRIORITY, MESSAGE-INTEGRITY, FINGERPRINT.
func BuildBindingRequest(req BindingRequest) []byte {
	username := req.RemoteUfrag + ":" + req.LocalUfrag

	buf := make([]byte, 0, 96+len(username))
	// Header: type + length placeholder + magic cookie + txn id
	buf = append(buf, 0, 0, 0, 0)
	buf = binary.BigEndian.AppendUint32(buf, stunMagicCookie)
	buf = append(buf, req.TxnID[:]...)

	// USERNAME
	buf = appendAttribute(buf, stunAttrUsername, []byte(username))

	// PRIORITY (32-bit)
	prio := make([]byte, 4)
	binary.BigEndian.PutUint32(prio, req.Priority)
	buf = appendAttribute(buf, stunAttrPriority, prio)

	// ICE-CONTROLLED (64-bit tiebreaker)
	tb := make([]byte, 8)
	binary.BigEndian.PutUint64(tb, req.Tiebreaker)
	buf = appendAttribute(buf, stunAttrICEControlled, tb)

	// Set class = Binding Request
	binary.BigEndian.PutUint16(buf[0:2], stunBindingRequest)

	// MESSAGE-INTEGRITY: HMAC-SHA1 over everything so far, length field
	// must include the trailing MI attribute (4+20=24 bytes).
	miLen := len(buf) - stunHeaderSize + 24
	binary.BigEndian.PutUint16(buf[2:4], uint16(miLen))
	mac := hmac.New(sha1.New, []byte(req.RemotePwd))
	mac.Write(buf)
	buf = appendAttribute(buf, stunAttrMessageIntegrity, mac.Sum(nil))

	// FINGERPRINT: CRC-32 of everything so far XOR 0x5354554E, length field
	// must include FP (4+4=8 bytes).
	fpLen := len(buf) - stunHeaderSize + 8
	binary.BigEndian.PutUint16(buf[2:4], uint16(fpLen))
	crc := crc32STUN(buf) ^ 0x5354554E
	fpBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(fpBuf, crc)
	buf = appendAttribute(buf, stunAttrFingerprint, fpBuf)

	// Final length (excludes the 20-byte header)
	binary.BigEndian.PutUint16(buf[2:4], uint16(len(buf)-stunHeaderSize))
	return buf
}

// ValidateBindingResponse checks that data is a successful STUN Binding
// Response that matches the given transaction ID and was signed with the
// given password, then returns the XOR-MAPPED-ADDRESS reported by the peer.
//
// For an ICE check the password fed in here is the *remote* password (the
// peer signs its response with its own ice-pwd, which we put into our
// request via MESSAGE-INTEGRITY — both sides use the same secret).
func ValidateBindingResponse(data []byte, txnID [12]byte, remotePwd string) (*net.UDPAddr, error) {
	if len(data) < stunHeaderSize {
		return nil, fmt.Errorf("stun: response too short (%d bytes)", len(data))
	}
	msgType := binary.BigEndian.Uint16(data[0:2])
	if msgType == stunBindingErrorResponse {
		return nil, fmt.Errorf("stun: binding error response")
	}
	if msgType != stunBindingResponse {
		return nil, fmt.Errorf("stun: unexpected message type 0x%04x", msgType)
	}
	declaredLen := binary.BigEndian.Uint16(data[2:4])
	if int(declaredLen)+stunHeaderSize != len(data) {
		return nil, fmt.Errorf("stun: length mismatch declared=%d actual=%d", declaredLen, len(data)-stunHeaderSize)
	}
	if binary.BigEndian.Uint32(data[4:8]) != stunMagicCookie {
		return nil, fmt.Errorf("stun: bad magic cookie")
	}
	var gotTxn [12]byte
	copy(gotTxn[:], data[8:20])
	if gotTxn != txnID {
		return nil, fmt.Errorf("stun: transaction id mismatch")
	}

	// Walk attributes.
	var xorMapped *net.UDPAddr
	var miOffset = -1 // start of MESSAGE-INTEGRITY attribute (incl. type/len)
	var fpOffset = -1
	offset := stunHeaderSize
	for offset+4 <= len(data) {
		attrType := binary.BigEndian.Uint16(data[offset : offset+2])
		attrLen := int(binary.BigEndian.Uint16(data[offset+2 : offset+4]))
		valStart := offset + 4
		valEnd := valStart + attrLen
		if valEnd > len(data) {
			return nil, fmt.Errorf("stun: attribute 0x%04x runs past end", attrType)
		}
		switch attrType {
		case stunAttrXORMappedAddress:
			addr, err := parseXORMappedAddress(data[valStart:valEnd], txnID)
			if err != nil {
				return nil, err
			}
			xorMapped = addr
		case stunAttrMessageIntegrity:
			miOffset = offset
		case stunAttrFingerprint:
			fpOffset = offset
		}
		// Pad to 4-byte boundary.
		pad := attrLen % 4
		if pad != 0 {
			valEnd += 4 - pad
		}
		offset = valEnd
	}

	if fpOffset < 0 {
		return nil, fmt.Errorf("stun: missing FINGERPRINT")
	}
	// Validate FINGERPRINT: covers everything up to the FP attribute.
	// The length field at the time FP was computed = (fpOffset - stunHeaderSize) + 8.
	fpLen := fpOffset - stunHeaderSize + 8
	hdrSnapshot := make([]byte, fpOffset)
	copy(hdrSnapshot, data[:fpOffset])
	binary.BigEndian.PutUint16(hdrSnapshot[2:4], uint16(fpLen))
	gotCRC := binary.BigEndian.Uint32(data[fpOffset+4 : fpOffset+8])
	wantCRC := crc32STUN(hdrSnapshot) ^ 0x5354554E
	if gotCRC != wantCRC {
		return nil, fmt.Errorf("stun: bad FINGERPRINT")
	}

	if miOffset < 0 {
		return nil, fmt.Errorf("stun: missing MESSAGE-INTEGRITY")
	}
	miLen := miOffset - stunHeaderSize + 24
	miSnapshot := make([]byte, miOffset)
	copy(miSnapshot, data[:miOffset])
	binary.BigEndian.PutUint16(miSnapshot[2:4], uint16(miLen))
	mac := hmac.New(sha1.New, []byte(remotePwd))
	mac.Write(miSnapshot)
	wantMI := mac.Sum(nil)
	gotMI := data[miOffset+4 : miOffset+4+20]
	if !hmac.Equal(wantMI, gotMI) {
		return nil, fmt.Errorf("stun: bad MESSAGE-INTEGRITY")
	}

	if xorMapped == nil {
		return nil, fmt.Errorf("stun: missing XOR-MAPPED-ADDRESS")
	}
	return xorMapped, nil
}

// parseXORMappedAddress decodes an RFC 5389 §15.2 XOR-MAPPED-ADDRESS value.
func parseXORMappedAddress(v []byte, txnID [12]byte) (*net.UDPAddr, error) {
	if len(v) < 8 {
		return nil, fmt.Errorf("stun: xor-mapped too short")
	}
	family := v[1]
	xPort := binary.BigEndian.Uint16(v[2:4])
	port := int(xPort ^ uint16(stunMagicCookie>>16))

	switch family {
	case 0x01: // IPv4
		if len(v) < 8 {
			return nil, fmt.Errorf("stun: xor-mapped v4 truncated")
		}
		xAddr := binary.BigEndian.Uint32(v[4:8])
		addr := xAddr ^ stunMagicCookie
		ip := make(net.IP, 4)
		binary.BigEndian.PutUint32(ip, addr)
		return &net.UDPAddr{IP: ip, Port: port}, nil
	case 0x02: // IPv6
		if len(v) < 20 {
			return nil, fmt.Errorf("stun: xor-mapped v6 truncated")
		}
		xorKey := make([]byte, 16)
		binary.BigEndian.PutUint32(xorKey[0:4], stunMagicCookie)
		copy(xorKey[4:], txnID[:])
		ip := make(net.IP, 16)
		for i := 0; i < 16; i++ {
			ip[i] = v[4+i] ^ xorKey[i]
		}
		return &net.UDPAddr{IP: ip, Port: port}, nil
	default:
		return nil, fmt.Errorf("stun: unknown address family 0x%02x", family)
	}
}
