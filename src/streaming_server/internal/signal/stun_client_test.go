package signal

import (
	"encoding/binary"
	"net"
	"testing"
)

// TestBindingRequest_RoundTrip drives a request through the receive-side
// handler (ICELite.HandleSTUN) and confirms the response parses back to
// the reflexive address we synthesised.
//
// ICELite.HandleSTUN signs the response with the *local* ice-pwd. From the
// outgoing-check side that is the remote pwd we put into BindingRequest,
// because both sides share that secret. The receiver doesn't currently
// validate the request's MI, but our caller signed it with the same pwd
// anyway, matching what a real peer would expect.
func TestBindingRequest_RoundTrip(t *testing.T) {
	const (
		localUfrag  = "srv1"
		remoteUfrag = "peer"
		remotePwd   = "0123456789abcdef0123456789ab" // shared secret in this test
	)
	txn := NewTransactionID()
	req := BuildBindingRequest(BindingRequest{
		TxnID:       txn,
		LocalUfrag:  localUfrag,
		RemoteUfrag: remoteUfrag,
		RemotePwd:   remotePwd,
		Priority:    0x6e7e00ff,
		Tiebreaker:  0xCAFEBABEDEADBEEF,
	})

	// Sanity: the bytes we produced should parse as a STUN message.
	if !IsSTUN(req) {
		t.Fatal("BuildBindingRequest output is not STUN")
	}
	if got := binary.BigEndian.Uint16(req[0:2]); got != stunBindingRequest {
		t.Fatalf("first message type = 0x%04x, want 0x0001", got)
	}

	// Synthesise an inbound packet from a peer at 203.0.113.45:55555.
	// HandleSTUN with that as remoteAddr will sign with localPwd.
	// We pass remotePwd into NewICELite as localPwd so the response uses it.
	receiver := NewICELite(remoteUfrag, remotePwd, localUfrag, remotePwd)
	resp := receiver.HandleSTUN(req, &net.UDPAddr{IP: net.IPv4(203, 0, 113, 45), Port: 55555})
	if resp == nil {
		t.Fatal("HandleSTUN returned nil — expected a binding response")
	}

	mapped, err := ValidateBindingResponse(resp, txn, remotePwd)
	if err != nil {
		t.Fatalf("ValidateBindingResponse: %v", err)
	}
	if !mapped.IP.Equal(net.IPv4(203, 0, 113, 45)) {
		t.Errorf("XOR-MAPPED-ADDRESS IP = %s, want 203.0.113.45", mapped.IP)
	}
	if mapped.Port != 55555 {
		t.Errorf("XOR-MAPPED-ADDRESS port = %d, want 55555", mapped.Port)
	}
}

func TestValidateBindingResponse_RejectsWrongTxn(t *testing.T) {
	const pwd = "0123456789abcdef0123456789ab"
	txn := NewTransactionID()
	req := BuildBindingRequest(BindingRequest{
		TxnID:       txn,
		LocalUfrag:  "srv",
		RemoteUfrag: "peer",
		RemotePwd:   pwd,
		Priority:    1,
		Tiebreaker:  1,
	})
	receiver := NewICELite("peer", pwd, "srv", pwd)
	resp := receiver.HandleSTUN(req, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1234})

	var otherTxn [12]byte
	otherTxn[0] = 0xFF
	if _, err := ValidateBindingResponse(resp, otherTxn, pwd); err == nil {
		t.Fatal("expected txn mismatch error, got nil")
	}
}

func TestValidateBindingResponse_RejectsTamperedFingerprint(t *testing.T) {
	const pwd = "0123456789abcdef0123456789ab"
	txn := NewTransactionID()
	req := BuildBindingRequest(BindingRequest{
		TxnID:       txn,
		LocalUfrag:  "srv",
		RemoteUfrag: "peer",
		RemotePwd:   pwd,
		Priority:    1,
		Tiebreaker:  1,
	})
	receiver := NewICELite("peer", pwd, "srv", pwd)
	resp := receiver.HandleSTUN(req, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1234})

	// Flip a byte inside the body (after header) — fingerprint must catch it.
	resp[stunHeaderSize+1] ^= 0x01
	if _, err := ValidateBindingResponse(resp, txn, pwd); err == nil {
		t.Fatal("expected fingerprint failure on tampered packet, got nil")
	}
}

func TestValidateBindingResponse_IPv6(t *testing.T) {
	const pwd = "0123456789abcdef0123456789ab"
	txn := NewTransactionID()
	req := BuildBindingRequest(BindingRequest{
		TxnID:       txn,
		LocalUfrag:  "srv",
		RemoteUfrag: "peer",
		RemotePwd:   pwd,
		Priority:    1,
		Tiebreaker:  1,
	})
	receiver := NewICELite("peer", pwd, "srv", pwd)
	peer := &net.UDPAddr{IP: net.ParseIP("2001:db8::1"), Port: 51000}
	resp := receiver.HandleSTUN(req, peer)
	mapped, err := ValidateBindingResponse(resp, txn, pwd)
	if err != nil {
		t.Fatalf("ValidateBindingResponse v6: %v", err)
	}
	if !mapped.IP.Equal(peer.IP) {
		t.Errorf("v6 mapped IP = %s, want %s", mapped.IP, peer.IP)
	}
	if mapped.Port != peer.Port {
		t.Errorf("v6 mapped port = %d, want %d", mapped.Port, peer.Port)
	}
}
