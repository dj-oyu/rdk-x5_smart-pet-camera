package signal

import (
	"context"
	"net"
	"testing"
	"time"
)

// TestICEFull_OutgoingCheckUnblocksWaitForICE drives the full ICE-full
// pathway against an in-process fake "browser":
//   - server-side session created in ICE-full mode with one peer candidate
//     pointing at the fake UDP listener.
//   - fake listener accepts the binding request, builds a binding response
//     using ICELite (which signs with our shared password), writes it back.
//   - server's iceCheckLoop + waitForICE pair should converge.
//
// This exercises the actual goroutine layout used in production: one
// writer (iceCheckLoop) and one reader (waitForICE) on the same UDP
// socket, plus the response-validation branch.
func TestICEFull_OutgoingCheckUnblocksWaitForICE(t *testing.T) {
	const (
		localUfrag  = "srv1"
		remoteUfrag = "peer1"
		remotePwd   = "0123456789abcdef0123456789ab"
	)

	// Fake browser: listens on 127.0.0.1, replies to first STUN binding
	// request with a binding response signed with the same password.
	browser, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close()
	browserAddr := browser.LocalAddr().(*net.UDPAddr)

	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 1500)
		browser.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, srvAddr, err := browser.ReadFromUDP(buf)
		if err != nil {
			t.Errorf("browser: read: %v", err)
			return
		}
		if !IsSTUN(buf[:n]) {
			t.Errorf("browser: first packet is not STUN")
			return
		}
		// Build a binding response — for that we re-use ICELite with the
		// shared pwd. From the fake browser's perspective it acts as the
		// "local" agent.
		fakeICE := NewICELite(remoteUfrag, remotePwd, localUfrag, remotePwd)
		resp := fakeICE.HandleSTUN(buf[:n], srvAddr)
		if resp == nil {
			t.Errorf("browser: HandleSTUN returned nil")
			return
		}
		if _, err := browser.WriteToUDP(resp, srvAddr); err != nil {
			t.Errorf("browser: write resp: %v", err)
			return
		}
	}()

	// Server side: local socket bound to an ephemeral port.
	srvConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer srvConn.Close()

	sess := &Session{
		id:            "test-icefull",
		udpConn:       srvConn,
		conn:          newSessionConn(srvConn, nil),
		iceLite:       NewICELite(localUfrag, remotePwd, remoteUfrag, remotePwd),
		enableICEFull: true,
		peerCandidates: []OfferCandidate{{
			Foundation: "1",
			Component:  1,
			Protocol:   "udp",
			Priority:   2113937151,
			IP:         browserAddr.IP,
			Port:       browserAddr.Port,
			Type:       CandidateHost,
		}},
		pendingChecks: make(map[string][12]byte),
	}
	srv := &Server{
		sessions: map[string]*Session{sess.id: sess},
		cfg:      Config{MaxClients: 1, EnableICEFull: true},
		basePort: 20000,
		nextPort: 20000,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	checkCtx, cancelChecks := context.WithCancel(ctx)
	defer cancelChecks()
	go srv.iceCheckLoop(checkCtx, sess)

	addr, err := srv.waitForICE(ctx, sess)
	if err != nil {
		t.Fatalf("waitForICE: %v", err)
	}
	if !addr.IP.Equal(browserAddr.IP) || addr.Port != browserAddr.Port {
		t.Errorf("got remote addr %s, want %s", addr, browserAddr)
	}

	cancelChecks()
	<-done
}

// TestICEFull_DisabledKeepsICELiteBehaviour confirms iceCheckLoop is a
// no-op when ICEFull is off — important because regression here would
// resurrect the old "no outbound checks" assumption silently.
func TestICEFull_DisabledKeepsICELiteBehaviour(t *testing.T) {
	srvConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer srvConn.Close()

	sess := &Session{
		id:            "test-icelite",
		udpConn:       srvConn,
		conn:          newSessionConn(srvConn, nil),
		iceLite:       NewICELite("u1", "p1", "u2", "p2"),
		enableICEFull: false,
		peerCandidates: []OfferCandidate{{
			Foundation: "1", Component: 1, Protocol: "udp",
			Priority: 1, IP: net.IPv4(127, 0, 0, 1), Port: 1, Type: CandidateHost,
		}},
		pendingChecks: make(map[string][12]byte),
	}
	srv := &Server{cfg: Config{MaxClients: 1}}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled — loop should still return cleanly even if it ran a tick
	srv.iceCheckLoop(ctx, sess)

	sess.mu.Lock()
	defer sess.mu.Unlock()
	if len(sess.pendingChecks) != 0 {
		t.Errorf("iceCheckLoop wrote pendingChecks while ICEFull disabled: %v", sess.pendingChecks)
	}
}
