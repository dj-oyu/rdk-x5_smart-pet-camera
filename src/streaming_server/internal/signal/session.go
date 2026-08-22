package signal

import (
	"context"
	"crypto/rand"
	"encoding/binary"
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
	// peerFingerprint は SDP offer の DTLS fingerprint。DTLS handshake 中に
	// pin して MITM を防ぐ (SDP offer's DTLS fingerprint, pinned during the
	// DTLS handshake).
	peerFingerprint string
	mu              sync.Mutex
	closed          bool
	framesSent      uint64
	enableICEFull   bool
	peerCandidates  []OfferCandidate
	// conn pins the source IP for outgoing v6 packets so it matches the
	// host candidate we advertised (see sessionconn.go). Always set; v4-
	// only or no-v6-candidate sessions still go through it as a plain
	// passthrough.
	conn *sessionConn
	// pendingChecks maps "<ip>:<port>" → the most recent transaction id we
	// sent that peer. Used to validate STUN binding responses arriving on
	// the same socket. Guarded by mu — single writer (iceCheckLoop), single
	// reader (waitForICE).
	pendingChecks map[string][12]byte
}

// writeTo sends b to dst via the session's sessionConn (source-pinned
// for v6, plain *net.UDPConn for v4).
func (sess *Session) writeTo(b []byte, dst *net.UDPAddr) (int, error) {
	return sess.conn.WriteToUDP(b, dst)
}

// Config controls feature flags for the signaling server. Defaults preserve
// the long-standing behaviour: ICE-lite (passive) with IPv4-only host
// candidates. New paths are opt-in so a misconfigured rollout cannot
// regress production streaming.
type Config struct {
	MaxClients           int
	EnableICEFull        bool // Phase A: server originates STUN binding requests
	EnableIPv6Candidates bool // Phase B (not yet wired): advertise v6 host candidates
}

// Server manages multiple WebRTC sessions.
type Server struct {
	mu           sync.RWMutex
	sessions     map[string]*Session
	dtlsConfig   *DTLSConfig
	cfg          Config
	candidateIPs []net.IP // all non-loopback IPv4 addresses to advertise
	basePort     int      // Starting UDP port for allocation
	nextPort     int
}

// NewServer creates a new signaling server with the given configuration.
func NewServer(cfg Config) (*Server, error) {
	if cfg.MaxClients <= 0 {
		cfg.MaxClients = 10
	}
	dtlsConfig, err := NewDTLSConfig()
	if err != nil {
		return nil, err
	}

	return &Server{
		sessions:     make(map[string]*Session),
		dtlsConfig:   dtlsConfig,
		cfg:          cfg,
		candidateIPs: getLocalCandidateAddrs(cfg.EnableIPv6Candidates),
		basePort:     20000,
		nextPort:     20000,
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
	logger.Info("Signal", "Offer: PT=%d, MID=%s, ufrag=%s, candidates=%d", offer.PayloadType, offer.MID, offer.ICEUfrag, len(offer.Candidates))
	for i, c := range offer.Candidates {
		logger.Info("Signal", "  offer.cand[%d]: %s %s:%d prio=%d found=%s", i, c.Type, c.IP, c.Port, c.Priority, c.Foundation)
	}

	// Check client limit
	s.mu.RLock()
	if len(s.sessions) >= s.cfg.MaxClients {
		s.mu.RUnlock()
		return nil, fmt.Errorf("signal: max clients reached (%d)", s.cfg.MaxClients)
	}
	s.mu.RUnlock()

	// Allocate UDP port. Bind to the IPv6 wildcard [::] with the "udp"
	// network so the socket accepts both v4 (via v4-mapped-v6) and v6
	// traffic on Linux (default IPV6_V6ONLY=0). We then advertise host
	// candidates for every interface address below.
	port := s.allocatePort()
	udpAddr := &net.UDPAddr{IP: net.IPv6zero, Port: port}
	udpConn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return nil, fmt.Errorf("signal: listen udp %d: %w", port, err)
	}

	// Generate ICE credentials
	localUfrag, localPwd := GenerateICECredentials()

	// Generate SDP answer. 各セッションごとに一意な SSRC を採番する
	// (per-session SSRC) — 全セッション共通の固定値だと RTCP feedback の
	// ルーティングができないため。
	sessSSRC := generateSSRC()
	answerSDP := GenerateAnswer(&AnswerParams{
		ICEUfrag:        localUfrag,
		ICEPwd:          localPwd,
		DTLSFingerprint: s.dtlsConfig.Fingerprint,
		CandidateIPs:    s.candidateIPs,
		CandidatePort:   port,
		PayloadType:     offer.PayloadType,
		MID:             offer.MID,
		FmtpLine:        offer.FmtpLine,
		SSRC:            sessSSRC,
		ICEFull:         s.cfg.EnableICEFull,
	})

	// Create session. conn pins the v6 source when we advertise at least
	// one v6 candidate; for v4 dsts and v4-only sessions it passes the
	// write straight through to udpConn.
	sess := &Session{
		id:              fmt.Sprintf("ws-%d", port),
		udpConn:         udpConn,
		conn:            newSessionConn(udpConn, firstV6(s.candidateIPs)),
		iceLite:         NewICELite(localUfrag, localPwd, offer.ICEUfrag, offer.ICEPwd),
		ssrc:            sessSSRC,
		payloadType:     uint8(offer.PayloadType),
		peerFingerprint: offer.Fingerprint,
		enableICEFull:   s.cfg.EnableICEFull,
		peerCandidates:  offer.Candidates,
		pendingChecks:   make(map[string][12]byte),
	}

	// Re-check the client limit under the write lock. The RLock check above
	// is an optimistic fast-reject; concurrent offers could still race past
	// it (TOCTOU), so the authoritative limit is enforced here at insert time.
	s.mu.Lock()
	if len(s.sessions) >= s.cfg.MaxClients {
		s.mu.Unlock()
		udpConn.Close()
		return nil, fmt.Errorf("signal: max clients reached (%d)", s.cfg.MaxClients)
	}
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

	// Phase 1a: in ICE-full mode, fire outgoing STUN binding requests at
	// every peer candidate. Two effects:
	//   (1) On NATted servers (MAP-E) this opens a mapping the browser's
	//       own checks can come back through.
	//   (2) If the browser's reply reaches us, waitForICE accepts it as
	//       success.
	// In ICE-lite (default) mode this returns immediately.
	checkCtx, cancelChecks := context.WithCancel(ctx)
	defer cancelChecks()
	go s.iceCheckLoop(checkCtx, sess)

	// Phase 1b: Wait for STUN binding requests (ICE connectivity check)
	// — or a valid binding response if iceCheckLoop is running.
	remoteAddr, err := s.waitForICE(ctx, sess)
	if err != nil {
		logger.Warn("Signal", "Session %s: ICE failed: %v", sess.id, err)
		return
	}
	cancelChecks() // ICE complete; stop sending checks before DTLS reads the socket.
	sess.mu.Lock()
	sess.remoteAddr = remoteAddr
	sess.mu.Unlock()
	logger.Info("Signal", "Session %s: ICE connected from %s", sess.id, remoteAddr)

	// Phase 2: DTLS handshake. The adapter shares sess.conn so DTLS
	// packets carry the same source IP as the host candidate we
	// advertised (see sessionconn.go).
	dtlsAdapter := newDTLSPacketConn(sess.udpConn, sess.conn, sess.iceLite, remoteAddr)
	logger.Info("Signal", "Session %s: starting DTLS handshake...", sess.id)
	dtlsSess, err := HandshakeDTLS(dtlsAdapter, remoteAddr, s.dtlsConfig, sess.peerFingerprint)
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
		// sendonly セッションは consent-refresh の遅延で 30s だと切断される
		// ため 45s に緩和する (keepalive timeout)。
		sess.udpConn.SetReadDeadline(time.Now().Add(45 * time.Second))
		n, addr, err := sess.udpConn.ReadFromUDP(buf)
		if err != nil {
			logger.Info("Signal", "Session %s: connection closed", sess.id)
			return
		}
		// Handle STUN keepalives
		if IsSTUN(buf[:n]) {
			resp := sess.iceLite.HandleSTUN(buf[:n], addr)
			if resp != nil {
				sess.writeTo(resp, addr)
			}
		}
		// Ignore RTCP or other packets
	}
}

// waitForICE waits for either an inbound STUN binding request (and
// responds), or a valid binding response to one of our outgoing checks
// (ICE-full mode only). Either is enough to declare the path usable.
//
// Source-address policy: in both cases the returned UDPAddr is the
// packet's source — that is the address DTLS can write back to (the
// XOR-MAPPED address only tells us how the peer sees *us*).
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

		if !IsSTUN(buf[:n]) {
			logger.Debug("Signal", "Session %s: non-STUN %d bytes from %s during ICE", sess.id, n, addr)
			continue
		}
		logger.Debug("Signal", "Session %s: STUN %d bytes from %s", sess.id, n, addr)
		// Inbound request: respond and treat as success.
		if resp := sess.iceLite.HandleSTUN(buf[:n], addr); resp != nil {
			sess.writeTo(resp, addr)
			return addr, nil
		}
		// Inbound response: only meaningful in ICE-full mode.
		if sess.enableICEFull {
			sess.mu.Lock()
			txn, ok := sess.pendingChecks[addr.String()]
			sess.mu.Unlock()
			if ok {
				if _, err := ValidateBindingResponse(buf[:n], txn, sess.iceLite.remotePwd); err == nil {
					return addr, nil
				}
				logger.Debug("Signal", "Session %s: invalid binding response from %s: %v", sess.id, addr, err)
			}
		}
	}
}

// iceCheckLoop sends periodic STUN binding requests to each peer
// candidate while the session is in the ICE phase.
//
// Retransmit schedule follows RFC 5389 §7.2: start RTO=500ms, double on
// every retransmission, give up after Rc=7 attempts (covers ~32s total
// wait, but the session-level 30s context will cancel us first).
func (s *Server) iceCheckLoop(ctx context.Context, sess *Session) {
	if !sess.enableICEFull || len(sess.peerCandidates) == 0 {
		return
	}
	rto := 500 * time.Millisecond
	for attempt := 0; attempt < 7; attempt++ {
		for _, c := range sess.peerCandidates {
			sess.mu.Lock()
			closed := sess.closed
			connected := sess.remoteAddr != nil
			sess.mu.Unlock()
			if closed || connected {
				return
			}
			addr := c.UDPAddr()
			txn := NewTransactionID()
			req := BuildBindingRequest(BindingRequest{
				TxnID:       txn,
				LocalUfrag:  sess.iceLite.localUfrag,
				RemoteUfrag: sess.iceLite.remoteUfrag,
				RemotePwd:   sess.iceLite.remotePwd,
				Priority:    prflxPriority(uint16(attempt)),
				Tiebreaker:  newTiebreaker(),
			})
			sess.mu.Lock()
			sess.pendingChecks[addr.String()] = txn
			sess.mu.Unlock()
			n, err := sess.writeTo(req, addr)
			if err != nil {
				logger.Warn("Signal", "Session %s: ICE check #%d → %s FAILED: %v", sess.id, attempt, addr, err)
			} else {
				logger.Debug("Signal", "Session %s: ICE check #%d → %s sent (%d bytes)", sess.id, attempt, addr, n)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(rto):
		}
		rto *= 2
	}
}

// prflxPriority returns a recommended priority value for peer-reflexive
// candidates per RFC 8445 §5.1.2: type-pref 110, local-pref 65535,
// component 1 → (110 << 24) | (65535 << 8) | (256 - 1). The local-pref
// is decreased by `bump` to avoid identical priorities across retries.
func prflxPriority(bump uint16) uint32 {
	const typePref uint32 = 110
	localPref := uint32(65535) - uint32(bump)
	return (typePref << 24) | (localPref << 8) | 255
}

// generateSSRC returns a random non-zero 32-bit SSRC for a session.
// SSRC=0 は予約値扱いになりうるため、0 が出たら 1 にフォールバックする。
func generateSSRC() uint32 {
	var b [4]byte
	_, _ = rand.Read(b[:])
	ssrc := binary.BigEndian.Uint32(b[:])
	if ssrc == 0 {
		ssrc = 1
	}
	return ssrc
}

// newTiebreaker returns a random 64-bit ICE tiebreaker.
func newTiebreaker() uint64 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return binary.BigEndian.Uint64(b[:])
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
			// このセッション固有の SSRC でヘッダを書き換える
			// (per-session SSRC)。SRTP の HMAC は SSRC を含むヘッダを
			// 認証するため、ヘッダのバイト列と EncryptRTP に渡す ssrc 引数は
			// 必ず一致させる。よって PutUint32 の後で sess.ssrc を読む。
			binary.BigEndian.PutUint32(buf[8:12], sess.ssrc)

			seq := uint16(buf[2])<<8 | uint16(buf[3])
			ssrc := sess.ssrc

			encrypted := make([]byte, len(buf)+srtp.AuthTagLen)
			encrypted, err := srtpCtx.EncryptRTP(encrypted, buf, 12, seq, ssrc)
			if err != nil {
				continue
			}

			sess.writeTo(encrypted, remoteAddr)
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
		// framesSent は SendFrame が sess.mu 下でインクリメントするので、
		// ログ用の読み取りもロック内で行う (race detector が検出した既存バグ)。
		sent := sess.framesSent
		sess.mu.Unlock()
		delete(s.sessions, id)
		logger.Info("Signal", "Session %s removed (sent: %d frames)", id, sent)
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

// ----- DTLS packet conn adapter -----

// dtlsPacketConn filters STUN packets out and passes only DTLS to pion/dtls.
type dtlsPacketConn struct {
	udp        *net.UDPConn // for reads only; writes go through sc
	sc         *sessionConn // shared with the parent Session
	iceLite    *ICELite
	remoteAddr *net.UDPAddr
}

func newDTLSPacketConn(udp *net.UDPConn, sc *sessionConn, iceLite *ICELite, remoteAddr *net.UDPAddr) *dtlsPacketConn {
	return &dtlsPacketConn{udp: udp, sc: sc, iceLite: iceLite, remoteAddr: remoteAddr}
}

func (d *dtlsPacketConn) ReadFrom(b []byte) (int, net.Addr, error) {
	for {
		n, addr, err := d.udp.ReadFromUDP(b)
		if err != nil {
			return 0, nil, err
		}
		// STUN packets: respond and continue reading
		if IsSTUN(b[:n]) {
			resp := d.iceLite.HandleSTUN(b[:n], addr)
			if resp != nil {
				d.sc.WriteToUDP(resp, addr)
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
	return d.sc.WriteToUDP(b, udpAddr)
}

func (d *dtlsPacketConn) Close() error {
	// Don't close the underlying conn — session manages it
	return nil
}

func (d *dtlsPacketConn) LocalAddr() net.Addr {
	return d.udp.LocalAddr()
}

func (d *dtlsPacketConn) SetDeadline(t time.Time) error      { return d.udp.SetDeadline(t) }
func (d *dtlsPacketConn) SetReadDeadline(t time.Time) error  { return d.udp.SetReadDeadline(t) }
func (d *dtlsPacketConn) SetWriteDeadline(t time.Time) error { return d.udp.SetWriteDeadline(t) }

// Ensure dtlsPacketConn satisfies net.PacketConn
var _ net.PacketConn = (*dtlsPacketConn)(nil)
