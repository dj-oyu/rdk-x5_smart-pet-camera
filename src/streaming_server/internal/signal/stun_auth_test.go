package signal

import (
	"net"
	"testing"
)

// TestHandleSTUN_RejectsForgedAuth proves that HandleSTUN drops Binding
// Requests whose short-term credentials don't match the local agent's
// ufrag/pwd (RFC 8445 §7.3). Without this an on-path host could hijack the
// ICE check by spoofing a Binding Request.
//
// Receiver is built the same way the round-trip fixtures do it
// (NewICELite(remoteUfrag, pwd, localUfrag, pwd)): the receiver's
// localUfrag:remoteUfrag is "peer:srv" and its localPwd is the shared secret.
// A legitimate request signs MI with that pwd and carries USERNAME
// "peer:srv"; the malicious cases below deliberately break one of those.
func TestHandleSTUN_RejectsForgedAuth(t *testing.T) {
	const (
		localUfrag  = "srv"
		remoteUfrag = "peer"
		pwd         = "0123456789abcdef0123456789ab" // shared secret
	)
	peer := &net.UDPAddr{IP: net.IPv4(203, 0, 113, 45), Port: 55555}

	cases := []struct {
		name string
		req  []byte
	}{
		{
			// MESSAGE-INTEGRITY signed with the wrong password.
			name: "forged message-integrity",
			req: BuildBindingRequest(BindingRequest{
				TxnID:       NewTransactionID(),
				LocalUfrag:  localUfrag,
				RemoteUfrag: remoteUfrag,
				RemotePwd:   "wrong-password-deadbeef-0000",
				Priority:    1,
				Tiebreaker:  1,
			}),
		},
		{
			// USERNAME does not match localUfrag:remoteUfrag. The request is
			// MI-signed correctly, but addressed to a different agent.
			name: "mismatched username",
			req: BuildBindingRequest(BindingRequest{
				TxnID:       NewTransactionID(),
				LocalUfrag:  "someoneelse",
				RemoteUfrag: "attacker",
				RemotePwd:   pwd,
				Priority:    1,
				Tiebreaker:  1,
			}),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			receiver := NewICELite(remoteUfrag, pwd, localUfrag, pwd)
			if resp := receiver.HandleSTUN(tc.req, peer); resp != nil {
				t.Fatalf("HandleSTUN accepted %s request — expected nil (dropped)", tc.name)
			}
		})
	}
}
