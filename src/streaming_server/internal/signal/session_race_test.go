package signal

import (
	"net"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/srtp"
)

// mustHex is a test helper (kept local to avoid depending on srtp_test.go).
func testHex(s string) []byte {
	b := make([]byte, 0, len(s)/2)
	var hi byte
	odd := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		var n byte
		switch {
		case '0' <= c && c <= '9':
			n = c - '0'
		case 'a' <= c && c <= 'f':
			n = c - 'a' + 10
		case 'A' <= c && c <= 'F':
			n = c - 'A' + 10
		default:
			continue
		}
		if !odd {
			hi = n << 4
			odd = true
		} else {
			b = append(b, hi|n)
			odd = false
		}
	}
	return b
}

// TestSendFrame_RaceWithRemoveSession reproduces the production panic
// scenario: SendFrame is encrypting/sending while removeSession closes the
// session. Prior to the fix, Context.Close() nil'd the SRTP cipher and
// concurrent EncryptRTP would SIGSEGV.
//
// The reproduction strategy: multiple SendFrame goroutines hammer the
// session with many packets, while removeSession fires shortly after.
// The bug is a narrow window between "SendFrame released sess.mu after
// capturing srtpCtx" and "SendFrame calls srtpCtx.EncryptRTP". Large
// packet batches per call widen that window per iteration.
func TestSendFrame_RaceWithRemoveSession(t *testing.T) {
	const (
		rounds          = 200
		sendGoroutines  = 4
		itersPerSender  = 20
		packetsPerFrame = 16
	)

	masterKey := testHex("E1F97A0D3E018BE0D64FA32C06DE4139")
	masterSalt := testHex("0EC675AD498AFEEBB6960B3AABE6")

	// Build a batch of packets. Many packets per SendFrame call means each
	// call spends more time in the inner loop calling EncryptRTP — the window
	// where removeSession can interleave is proportionally wider.
	packets := make([][]byte, packetsPerFrame)
	for i := range packets {
		p := make([]byte, 12+256)
		p[0] = 0x80
		p[1] = 0x60
		p[2] = byte(i >> 8)
		p[3] = byte(i)
		p[8], p[9], p[10], p[11] = 0x12, 0x34, 0x56, 0x78
		packets[i] = p
	}

	panicTotal := atomic.Int64{}

	for trial := 0; trial < rounds; trial++ {
		srv, sess, cleanup := newTestSession(t, masterKey, masterSalt)

		var wg sync.WaitGroup
		startGate := make(chan struct{})

		for g := 0; g < sendGoroutines; g++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() {
					if r := recover(); r != nil {
						panicTotal.Add(1)
						t.Errorf("trial %d: SendFrame panicked: %v", trial, r)
					}
				}()
				<-startGate
				for i := 0; i < itersPerSender; i++ {
					srv.SendFrame(packets)
				}
			}()
		}

		wg.Add(1)
		go func() {
			defer wg.Done()
			<-startGate
			// Let senders get into the encrypt loop before closing.
			srv.removeSession(sess.id)
		}()

		close(startGate)
		wg.Wait()
		cleanup()

		if panicTotal.Load() != 0 {
			t.Fatalf("trial %d: SendFrame panicked under race — SRTP cipher is not safe to share during close", trial)
		}
	}
}

// newTestSession builds a Server + one fully-initialized Session without
// running the real ICE/DTLS handshake. Suitable for driving SendFrame in
// unit tests.
func newTestSession(t *testing.T, masterKey, masterSalt []byte) (*Server, *Session, func()) {
	t.Helper()

	// Local UDP socket for the session's "sender" side.
	localConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}

	// Dummy UDP sink to absorb encrypted packets (keeps WriteToUDP cheap and silent).
	sink, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		localConn.Close()
		t.Fatal(err)
	}
	remoteAddr := sink.LocalAddr().(*net.UDPAddr)

	srtpCtx, err := srtp.NewContext(masterKey, masterSalt)
	if err != nil {
		localConn.Close()
		sink.Close()
		t.Fatal(err)
	}

	sess := &Session{
		id:          "test-" + localConn.LocalAddr().String(),
		udpConn:     localConn,
		remoteAddr:  remoteAddr,
		srtpCtx:     srtpCtx,
		ssrc:        0x12345678,
		payloadType: 96,
	}

	srv := &Server{
		sessions:   map[string]*Session{sess.id: sess},
		maxClients: 1,
		basePort:   20000,
		nextPort:   20000,
	}

	cleanup := func() {
		// removeSession may have already closed the conn.
		_ = localConn.Close()
		_ = sink.Close()
	}
	return srv, sess, cleanup
}
