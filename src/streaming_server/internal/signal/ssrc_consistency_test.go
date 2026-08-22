package signal

import (
	"net"
	"regexp"
	"strconv"
	"testing"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/srtp"
)

// reAnswerSSRC extracts the numeric SSRC from an "a=ssrc:<id> ..." line in
// a generated SDP answer.
var reAnswerSSRC = regexp.MustCompile(`a=ssrc:(\d+)`)

// TestSDPSSRCMatchesWireSSRC is a regression test for the bug fixed in
// PR #215 (fix(streaming): resolve 10 WebRTC review findings): the SDP
// answer must advertise the exact SSRC that ends up on the wire in the
// encrypted RTP packets SendFrame emits for that session. Before that fix,
// session.go advertised a per-session SSRC in the SDP answer while
// SendFrame forwarded packets carrying whatever SSRC main.go's packetizer
// had baked in (a single value shared by every session), so the two never
// matched.
//
// SendFrame's per-session header rewrite (session.go: "binary.BigEndian.
// PutUint32(buf[8:12], sess.ssrc)" right before EncryptRTP) is what keeps
// them in sync today — it rewrites the SSRC field of every packet,
// regardless of what the upstream packetizer used, to sess.ssrc before
// encrypting. Since SRTP only encrypts the RTP payload (the 12-byte
// header, including SSRC, is sent in the clear and merely authenticated
// by the HMAC tag), the wire SSRC can be read directly off the packet
// SendFrame writes to the peer.
func TestSDPSSRCMatchesWireSSRC(t *testing.T) {
	sessSSRC := generateSSRC()
	if sessSSRC == 0 {
		t.Fatal("generateSSRC returned reserved value 0")
	}

	// Build the SDP answer exactly as HandleOffer does, and parse back the
	// SSRC it advertises.
	answerSDP := GenerateAnswer(&AnswerParams{
		ICEUfrag:        "ufrag",
		ICEPwd:          "password1234567890ab",
		DTLSFingerprint: "AA:BB",
		CandidateIPs:    []net.IP{net.IPv4(127, 0, 0, 1)},
		CandidatePort:   20000,
		PayloadType:     96,
		MID:             "0",
		SSRC:            sessSSRC,
	})
	m := reAnswerSSRC.FindStringSubmatch(answerSDP)
	if m == nil {
		t.Fatal("answer SDP has no a=ssrc line")
	}
	advertised, err := strconv.ParseUint(m[1], 10, 32)
	if err != nil {
		t.Fatalf("parse advertised SSRC: %v", err)
	}
	if uint32(advertised) != sessSSRC {
		t.Fatalf("SDP advertises SSRC %d, want %d", advertised, sessSSRC)
	}

	// Set up a minimal session (mirrors newTestSession in
	// session_race_test.go) whose ssrc matches what the SDP above
	// advertised, plus a "sink" socket we can read the wire packet back
	// from directly.
	localConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer localConn.Close()

	sink, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	remoteAddr := sink.LocalAddr().(*net.UDPAddr)

	masterKey := testHex("E1F97A0D3E018BE0D64FA32C06DE4139")
	masterSalt := testHex("0EC675AD498AFEEBB6960B3AABE6")
	srtpCtx, err := srtp.NewContext(masterKey, masterSalt)
	if err != nil {
		t.Fatal(err)
	}

	sess := &Session{
		id:          "ssrc-consistency-test",
		udpConn:     localConn,
		conn:        newSessionConn(localConn, nil),
		remoteAddr:  remoteAddr,
		srtpCtx:     srtpCtx,
		ssrc:        uint32(advertised),
		payloadType: 96,
	}
	srv := &Server{
		sessions: map[string]*Session{sess.id: sess},
		cfg:      Config{MaxClients: 1},
	}

	// Drive SendFrame with a packet carrying a *different* placeholder
	// SSRC — mirroring main.go's shared rtpSSRC=0x12345678 packetizer
	// value — to prove SendFrame rewrites it to sess.ssrc before the
	// packet reaches the wire.
	var placeholderSSRC uint32 = 0x12345678
	pkt := make([]byte, 12+16)
	pkt[0] = 0x80
	pkt[1] = 0x60
	pkt[2], pkt[3] = 0x00, 0x01 // seq
	pkt[8] = byte(placeholderSSRC >> 24)
	pkt[9] = byte(placeholderSSRC >> 16)
	pkt[10] = byte(placeholderSSRC >> 8)
	pkt[11] = byte(placeholderSSRC)

	srv.SendFrame([][]byte{pkt})

	// Read the packet SendFrame actually put on the wire. RTP headers are
	// sent in the clear under SRTP (only the payload is encrypted), so the
	// SSRC field can be read directly.
	sink.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 1500)
	n, _, err := sink.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("read wire packet: %v", err)
	}
	if n < 12 {
		t.Fatalf("wire packet too short: %d bytes", n)
	}
	wireSSRC := uint32(buf[8])<<24 | uint32(buf[9])<<16 | uint32(buf[10])<<8 | uint32(buf[11])

	if wireSSRC != sessSSRC {
		t.Fatalf("wire SSRC %08x != SDP-advertised SSRC %08x", wireSSRC, sessSSRC)
	}
	if wireSSRC == placeholderSSRC {
		t.Fatalf("wire SSRC still carries the packetizer placeholder %08x; SendFrame did not rewrite it", placeholderSSRC)
	}
}
