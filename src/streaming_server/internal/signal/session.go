package signal

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/srtp"
)

// Session represents a single WebRTC client connection.
type Session struct {
	id          string
	udpConn     *net.UDPConn
	remoteAddr  *net.UDPAddr
	iceLite     *ICELite
	srtpCtx     *srtp.Context
	ssrc        uint32
	seq         uint16
	payloadType uint8 // H.265 PT from SDP negotiation
	mu          sync.Mutex
	closed      bool
	framesSent  uint64
}

// Server manages multiple WebRTC sessions.
type Server struct {
	mu         sync.RWMutex
	sessions   map[string]*Session
	dtlsConfig *DTLSConfig
	maxClients int
	listenIP   net.IP
	basePort   int // Starting UDP port for allocation
	nextPort   int
}

// NewServer creates a new signaling server.
func NewServer(maxClients int) (*Server, error) {
	dtlsConfig, err := NewDTLSConfig()
	if err != nil {
		return nil, err
	}

	// Find local IP
	ip := getLocalIP()

	return &Server{
		sessions:   make(map[string]*Session),
		dtlsConfig: dtlsConfig,
		maxClients: maxClients,
		listenIP:   ip,
		basePort:   20000,
		nextPort:   20000,
	}, nil
}

// HandleOffer processes a WebRTC offer and returns an answer.
// Compatible with the existing HTTP API (same JSON format as pion version).
func (s *Server) HandleOffer(offerJSON []byte) ([]byte, error) {
	// Parse offer
	var sdpMsg struct {
		SDP  string `json:"sdp"`
		Type string `json:"type"`
	}
	if err := json.Unmarshal(offerJSON, &sdpMsg); err != nil {
		return nil, fmt.Errorf("signal: parse offer json: %w", err)
	}

	offer, err := ParseOffer(sdpMsg.SDP)
	if err != nil {
		return nil, fmt.Errorf("signal: parse sdp: %w", err)
	}
	logger.Info("Signal", "Offer: PT=%d, MID=%s, ufrag=%s", offer.PayloadType, offer.MID, offer.ICEUfrag)

	// Check client limit
	s.mu.RLock()
	if len(s.sessions) >= s.maxClients {
		s.mu.RUnlock()
		return nil, fmt.Errorf("signal: max clients reached (%d)", s.maxClients)
	}
	s.mu.RUnlock()

	// Allocate UDP port
	port := s.allocatePort()
	udpAddr := &net.UDPAddr{IP: s.listenIP, Port: port}
	udpConn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return nil, fmt.Errorf("signal: listen udp %d: %w", port, err)
	}

	// Generate ICE credentials
	localUfrag, localPwd := GenerateICECredentials()

	// Generate SDP answer
	answerSDP := GenerateAnswer(&AnswerParams{
		ICEUfrag:        localUfrag,
		ICEPwd:          localPwd,
		DTLSFingerprint: s.dtlsConfig.Fingerprint,
		CandidateIP:     s.listenIP,
		CandidatePort:   port,
		PayloadType:     offer.PayloadType,
		MID:             offer.MID,
	})

	// Create session
	sess := &Session{
		id:          fmt.Sprintf("ws-%d", port),
		udpConn:     udpConn,
		iceLite:     NewICELite(localUfrag, localPwd, offer.ICEUfrag, offer.ICEPwd),
		ssrc:        0x12345678,
		payloadType: uint8(offer.PayloadType),
	}

	s.mu.Lock()
	s.sessions[sess.id] = sess
	s.mu.Unlock()

	// Start ICE → DTLS → SRTP pipeline in background
	go s.runSession(sess)

	logger.Info("Signal", "Session %s: offer accepted, port %d", sess.id, port)

	// Return answer in same JSON format as pion
	answerJSON, err := json.Marshal(map[string]string{
		"type": "answer",
		"sdp":  answerSDP,
	})
	if err != nil {
		return nil, err
	}

	return answerJSON, nil
}

// runSession handles the ICE→DTLS→SRTP lifecycle for a session.
func (s *Server) runSession(sess *Session) {
	defer s.removeSession(sess.id)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Phase 1: Wait for STUN binding requests (ICE connectivity check)
	remoteAddr, err := s.waitForICE(ctx, sess)
	if err != nil {
		logger.Warn("Signal", "Session %s: ICE failed: %v", sess.id, err)
		return
	}
	sess.remoteAddr = remoteAddr
	logger.Info("Signal", "Session %s: ICE connected from %s", sess.id, remoteAddr)

	// Phase 2: DTLS handshake
	// Create a packet conn adapter for pion/dtls (filters STUN, passes DTLS)
	dtlsAdapter := newDTLSPacketConn(sess.udpConn, sess.iceLite, remoteAddr)
	logger.Info("Signal", "Session %s: starting DTLS handshake...", sess.id)
	dtlsSess, err := HandshakeDTLS(dtlsAdapter, remoteAddr, s.dtlsConfig)
	if err != nil {
		logger.Warn("Signal", "Session %s: DTLS handshake failed: %v", sess.id, err)
		return
	}
	defer dtlsSess.Close()

	// Phase 3: Extract SRTP keys
	keyMaterial, err := dtlsSess.ExportSRTPKeys()
	if err != nil {
		logger.Warn("Signal", "Session %s: SRTP key export failed: %v", sess.id, err)
		return
	}

	// We are DTLS server (isClient=false)
	srtpCtx, err := srtp.FromKeyMaterial(keyMaterial, 16, 14, false)
	if err != nil {
		logger.Warn("Signal", "Session %s: SRTP context failed: %v", sess.id, err)
		return
	}

	sess.mu.Lock()
	sess.srtpCtx = srtpCtx
	sess.mu.Unlock()

	logger.Info("Signal", "Session %s: SRTP ready", sess.id)

	// Keep session alive until connection drops
	// Read loop to handle any incoming packets (STUN keepalives, RTCP)
	buf := make([]byte, 1500)
	for {
		sess.udpConn.SetReadDeadline(time.Now().Add(30 * time.Second))
		n, addr, err := sess.udpConn.ReadFromUDP(buf)
		if err != nil {
			logger.Info("Signal", "Session %s: connection closed", sess.id)
			return
		}
		// Handle STUN keepalives
		if IsSTUN(buf[:n]) {
			resp := sess.iceLite.HandleSTUN(buf[:n], addr)
			if resp != nil {
				sess.udpConn.WriteToUDP(resp, addr)
			}
		}
		// Ignore RTCP or other packets
	}
}

// waitForICE waits for the first STUN binding request and responds.
func (s *Server) waitForICE(ctx context.Context, sess *Session) (*net.UDPAddr, error) {
	buf := make([]byte, 1500)
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		sess.udpConn.SetReadDeadline(time.Now().Add(1 * time.Second))
		n, addr, err := sess.udpConn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			return nil, err
		}

		if IsSTUN(buf[:n]) {
			resp := sess.iceLite.HandleSTUN(buf[:n], addr)
			if resp != nil {
				sess.udpConn.WriteToUDP(resp, addr)
				return addr, nil
			}
		}
	}
}

// SendFrame sends SRTP-encrypted RTP packets to all connected sessions.
func (s *Server) SendFrame(rtpPackets [][]byte) {
	s.mu.RLock()
	sessions := make([]*Session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		sessions = append(sessions, sess)
	}
	s.mu.RUnlock()

	for _, sess := range sessions {
		sess.mu.Lock()
		if sess.srtpCtx == nil || sess.closed {
			sess.mu.Unlock()
			continue
		}
		srtpCtx := sess.srtpCtx
		remoteAddr := sess.remoteAddr
		conn := sess.udpConn
		sess.mu.Unlock()

		pt := sess.payloadType
		for _, pkt := range rtpPackets {
			if len(pkt) < 12 {
				continue
			}

			// Copy packet so we can safely overwrite the PT for this client.
			// EncryptRTP also copies into dst, but HMAC authenticates the header
			// including PT, so the header must have the correct PT before encryption.
			buf := make([]byte, len(pkt))
			copy(buf, pkt)
			buf[1] = (buf[1] & 0x80) | (pt & 0x7F)

			seq := uint16(buf[2])<<8 | uint16(buf[3])
			ssrc := uint32(buf[8])<<24 | uint32(buf[9])<<16 | uint32(buf[10])<<8 | uint32(buf[11])

			encrypted := make([]byte, len(buf)+srtp.AuthTagLen)
			encrypted, err := srtpCtx.EncryptRTP(encrypted, buf, 12, seq, ssrc)
			if err != nil {
				continue
			}

			conn.WriteToUDP(encrypted, remoteAddr)
		}

		sess.mu.Lock()
		sess.framesSent++
		sess.mu.Unlock()
	}
}

// GetClientCount returns the number of connected sessions with active SRTP.
func (s *Server) GetClientCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	count := 0
	for _, sess := range s.sessions {
		sess.mu.Lock()
		if sess.srtpCtx != nil && !sess.closed {
			count++
		}
		sess.mu.Unlock()
	}
	return count
}

// Close shuts down all sessions.
func (s *Server) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for id, sess := range s.sessions {
		sess.mu.Lock()
		sess.closed = true
		// srtpCtx is immutable software crypto — no Close needed, GC reclaims.
		sess.udpConn.Close()
		sess.mu.Unlock()
		delete(s.sessions, id)
	}
	return nil
}

func (s *Server) removeSession(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if sess, ok := s.sessions[id]; ok {
		sess.mu.Lock()
		sess.closed = true
		// srtpCtx is immutable software crypto — no Close needed, GC reclaims.
		sess.udpConn.Close()
		sess.mu.Unlock()
		delete(s.sessions, id)
		logger.Info("Signal", "Session %s removed (sent: %d frames)", id, sess.framesSent)
	}
}

func (s *Server) allocatePort() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	port := s.nextPort
	s.nextPort++
	if s.nextPort > 30000 {
		s.nextPort = s.basePort
	}
	return port
}

func getLocalIP() net.IP {
	// Prefer non-loopback IPv4
	addrs, _ := net.InterfaceAddrs()
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() {
			if ip4 := ipNet.IP.To4(); ip4 != nil {
				return ip4
			}
		}
	}
	return net.IPv4(127, 0, 0, 1)
}

// ----- DTLS packet conn adapter -----

// dtlsPacketConn filters STUN packets out and passes only DTLS to pion/dtls.
type dtlsPacketConn struct {
	conn       *net.UDPConn
	iceLite    *ICELite
	remoteAddr *net.UDPAddr
}

func newDTLSPacketConn(conn *net.UDPConn, iceLite *ICELite, remoteAddr *net.UDPAddr) *dtlsPacketConn {
	return &dtlsPacketConn{conn: conn, iceLite: iceLite, remoteAddr: remoteAddr}
}

func (d *dtlsPacketConn) ReadFrom(b []byte) (int, net.Addr, error) {
	for {
		n, addr, err := d.conn.ReadFromUDP(b)
		if err != nil {
			return 0, nil, err
		}
		// STUN packets: respond and continue reading
		if IsSTUN(b[:n]) {
			resp := d.iceLite.HandleSTUN(b[:n], addr)
			if resp != nil {
				d.conn.WriteToUDP(resp, addr)
			}
			continue
		}
		// DTLS packets: content types 20-63 (RFC 4347)
		// 20=ChangeCipherSpec, 21=Alert, 22=Handshake, 23=ApplicationData
		if n > 0 && b[0] >= 20 && b[0] <= 63 {
			return n, addr, nil
		}
		logger.Debug("Signal", "DTLS adapter: skipping packet type 0x%02x len=%d from %s", b[0], n, addr)
		// Other packets (RTP/RTCP from browser): ignore
	}
}

func (d *dtlsPacketConn) WriteTo(b []byte, addr net.Addr) (int, error) {
	udpAddr, ok := addr.(*net.UDPAddr)
	if !ok {
		udpAddr = d.remoteAddr
	}
	return d.conn.WriteToUDP(b, udpAddr)
}

func (d *dtlsPacketConn) Close() error {
	// Don't close the underlying conn — session manages it
	return nil
}

func (d *dtlsPacketConn) LocalAddr() net.Addr {
	return d.conn.LocalAddr()
}

func (d *dtlsPacketConn) SetDeadline(t time.Time) error      { return d.conn.SetDeadline(t) }
func (d *dtlsPacketConn) SetReadDeadline(t time.Time) error   { return d.conn.SetReadDeadline(t) }
func (d *dtlsPacketConn) SetWriteDeadline(t time.Time) error  { return d.conn.SetWriteDeadline(t) }

// Ensure dtlsPacketConn satisfies net.PacketConn
var _ net.PacketConn = (*dtlsPacketConn)(nil)
