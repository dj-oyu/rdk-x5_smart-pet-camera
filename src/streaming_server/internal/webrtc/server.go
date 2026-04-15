package webrtc

import (
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"sync"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/types"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

const (
	// Video clock rate (90kHz standard for RTP video)
	videoClockRate = 90000
	// RTP MTU for UDP-safe fragmentation
	rtpMTU = 1200
)

// Client represents a connected WebRTC client
type Client struct {
	id         string
	peerConn   *webrtc.PeerConnection
	videoTrack *webrtc.TrackLocalStaticRTP
	framesSent uint64
	seq        uint16
}

// Server manages WebRTC connections
type Server struct {
	clients    map[string]*Client
	clientsMu  sync.RWMutex
	clientsBuf []*Client
	config     webrtc.Configuration
	maxClients int
	api        *webrtc.API
	// payloader is stateless; shared across clients to parse NAL units once per frame.
	payloader codecs.H265Payloader
	frameNum  uint64
}

// NewServer creates a new WebRTC server
func NewServer(stunServers []string, maxClients int) *Server {
	// Configure ICE servers
	iceServers := make([]webrtc.ICEServer, 0, len(stunServers))
	for _, url := range stunServers {
		iceServers = append(iceServers, webrtc.ICEServer{
			URLs: []string{url},
		})
	}

	// If no STUN servers provided, use default
	if len(iceServers) == 0 {
		iceServers = []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302"},
			},
		}
	}

	// Optimize SettingsEngine for lower CPU usage
	settingsEngine := webrtc.SettingEngine{}

	// Reduce DTLS retransmission timeout (faster connection, less CPU on retries)
	settingsEngine.SetDTLSRetransmissionInterval(time.Second * 2)

	// Enable lightweight network condition detection
	settingsEngine.SetNetworkTypes([]webrtc.NetworkType{
		webrtc.NetworkTypeUDP4,
		webrtc.NetworkTypeUDP6,
	})

	// Create MediaEngine with H.265 codec (included in pion/webrtc v4 defaults)
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		logger.Error("WebRTC", "Failed to register codecs: %v", err)
	}

	// Create API with optimized settings
	api := webrtc.NewAPI(
		webrtc.WithSettingEngine(settingsEngine),
		webrtc.WithMediaEngine(mediaEngine),
	)

	return &Server{
		clients: make(map[string]*Client),
		config: webrtc.Configuration{
			ICEServers: iceServers,
		},
		maxClients: maxClients,
		api:        api,
	}
}

// HandleOffer handles a WebRTC offer and returns an answer
func (s *Server) HandleOffer(offerJSON []byte) ([]byte, error) {
	// Parse offer
	var offer webrtc.SessionDescription
	if err := json.Unmarshal(offerJSON, &offer); err != nil {
		return nil, fmt.Errorf("failed to parse offer: %w", err)
	}

	// Check client limit
	s.clientsMu.RLock()
	numClients := len(s.clients)
	s.clientsMu.RUnlock()

	if numClients >= s.maxClients {
		return nil, fmt.Errorf("maximum clients reached (%d)", s.maxClients)
	}

	// Create peer connection with optimized settings
	peerConn, err := s.api.NewPeerConnection(s.config)
	if err != nil {
		return nil, fmt.Errorf("failed to create peer connection: %w", err)
	}

	// Create H.265 video track (raw RTP; server pre-packetizes once per frame)
	videoTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeH265,
			ClockRate: videoClockRate,
		},
		"video",
		"pion",
	)
	if err != nil {
		peerConn.Close()
		return nil, fmt.Errorf("failed to create video track: %w", err)
	}

	// Add track to peer connection
	rtpSender, err := peerConn.AddTrack(videoTrack)
	if err != nil {
		peerConn.Close()
		return nil, fmt.Errorf("failed to add track: %w", err)
	}

	// Handle RTCP packets (for quality feedback)
	go func() {
		rtcpBuf := make([]byte, 1500)
		for {
			if _, _, err := rtpSender.Read(rtcpBuf); err != nil {
				return
			}
		}
	}()

	// Create client. RTP sequence starts at a random value (RFC 3550).
	client := &Client{
		id:         generateClientID(),
		peerConn:   peerConn,
		videoTrack: videoTrack,
		seq:        uint16(rand.Uint32()),
	}

	// Handle ICE connection state changes
	peerConn.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		logger.Debug("WebRTC", "Client %s ICE state: %s", client.id, state.String())

		// Remove client on disconnection, failure, or close
		if state == webrtc.ICEConnectionStateDisconnected ||
			state == webrtc.ICEConnectionStateFailed ||
			state == webrtc.ICEConnectionStateClosed {
			logger.Info("WebRTC", "Client %s connection lost (ICE: %s), removing...", client.id, state.String())
			s.RemoveClient(client.id)
		}
	})

	// Handle peer connection state changes (more comprehensive than ICE state)
	peerConn.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		logger.Debug("WebRTC", "Client %s connection state: %s", client.id, state.String())

		// Remove client on disconnection or failure
		if state == webrtc.PeerConnectionStateDisconnected ||
			state == webrtc.PeerConnectionStateFailed ||
			state == webrtc.PeerConnectionStateClosed {
			logger.Info("WebRTC", "Client %s connection lost (Peer: %s), removing...", client.id, state.String())
			s.RemoveClient(client.id)
		}
	})

	// Set remote description (offer)
	if err := peerConn.SetRemoteDescription(offer); err != nil {
		peerConn.Close()
		return nil, fmt.Errorf("failed to set remote description: %w", err)
	}

	// Create answer
	answer, err := peerConn.CreateAnswer(nil)
	if err != nil {
		peerConn.Close()
		return nil, fmt.Errorf("failed to create answer: %w", err)
	}

	// Create a channel to signal when ICE gathering is complete
	gatherComplete := webrtc.GatheringCompletePromise(peerConn)

	// Set local description (answer)
	if err := peerConn.SetLocalDescription(answer); err != nil {
		peerConn.Close()
		return nil, fmt.Errorf("failed to set local description: %w", err)
	}

	// Wait for ICE gathering to complete
	<-gatherComplete
	logger.Debug("WebRTC", "ICE gathering complete for client %s", client.id)

	// Add client to server
	s.clientsMu.Lock()
	s.clients[client.id] = client
	s.clientsMu.Unlock()

	logger.Info("WebRTC", "Client %s connected", client.id)

	// Get the complete local description (with ICE candidates)
	localDesc := peerConn.LocalDescription()
	if localDesc == nil {
		return nil, fmt.Errorf("no local description available")
	}

	// Return answer as JSON (now includes ICE candidates)
	answerJSON, err := json.Marshal(localDesc)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal answer: %w", err)
	}

	return answerJSON, nil
}

// SendFrame payloads the H.265 access unit once and fans the resulting RTP
// payloads out to every connected client. Blocks until all WriteRTP calls
// complete so frame.Data (backed by the VPU SHM buffer) stays valid.
func (s *Server) SendFrame(frame *types.VideoFrame) {
	s.clientsMu.RLock()
	s.clientsBuf = s.clientsBuf[:0]
	for _, c := range s.clients {
		s.clientsBuf = append(s.clientsBuf, c)
	}
	clients := s.clientsBuf
	s.clientsMu.RUnlock()

	if len(clients) == 0 {
		return
	}

	// NAL parsing + FU fragmentation happens once; payload bytes are shared.
	payloads := s.payloader.Payload(rtpMTU, frame.Data)
	if len(payloads) == 0 {
		return
	}

	ts := uint32(s.frameNum * (videoClockRate / 30))
	s.frameNum++
	last := len(payloads) - 1

	var wg sync.WaitGroup
	for _, client := range clients {
		wg.Add(1)
		go func(c *Client) {
			defer wg.Done()
			for i, payload := range payloads {
				pkt := rtp.Packet{
					Header: rtp.Header{
						Version:        2,
						Marker:         i == last,
						SequenceNumber: c.seq,
						Timestamp:      ts,
					},
					Payload: payload,
				}
				c.seq++
				if err := c.videoTrack.WriteRTP(&pkt); err != nil {
					if err != io.ErrClosedPipe {
						logger.Warn("WebRTC", "Error writing RTP for client %s: %v", c.id, err)
					}
					return
				}
			}
			c.framesSent++
		}(client)
	}
	wg.Wait()
}

// RemoveClient removes a client by ID
func (s *Server) RemoveClient(clientID string) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	client, exists := s.clients[clientID]
	if !exists {
		return
	}

	client.peerConn.Close()
	delete(s.clients, clientID)

	logger.Info("WebRTC", "Client %s disconnected (sent: %d)",
		clientID, client.framesSent)
}

// GetClientCount returns the number of connected clients
func (s *Server) GetClientCount() int {
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()
	return len(s.clients)
}

// GetClientStats returns stats for all clients
func (s *Server) GetClientStats() map[string]map[string]uint64 {
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()

	stats := make(map[string]map[string]uint64)
	for id, client := range s.clients {
		stats[id] = map[string]uint64{
			"frames_sent": client.framesSent,
		}
	}
	return stats
}

// Close closes all client connections
func (s *Server) Close() error {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	for id := range s.clients {
		s.RemoveClient(id)
	}

	return nil
}

// generateClientID generates a unique client ID
func generateClientID() string {
	return fmt.Sprintf("client-%d", time.Now().UnixNano())
}
