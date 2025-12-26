package webrtc

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/types"
	"github.com/pion/webrtc/v3"
	"github.com/pion/webrtc/v3/pkg/media"
)

const (
	// H.264 clock rate (90kHz for video)
	h264ClockRate = 90000
)

// Client represents a connected WebRTC client
type Client struct {
	id            string
	peerConn      *webrtc.PeerConnection
	videoTrack    *webrtc.TrackLocalStaticSample
	frameChan     chan *types.H264Frame
	closeChan     chan struct{}
	framesSent    uint64
	framesDropped uint64
}

// Server manages WebRTC connections
type Server struct {
	clients   map[string]*Client
	clientsMu sync.RWMutex
	config    webrtc.Configuration
	maxClients int
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

	return &Server{
		clients: make(map[string]*Client),
		config: webrtc.Configuration{
			ICEServers: iceServers,
		},
		maxClients: maxClients,
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

	// Create peer connection
	peerConn, err := webrtc.NewPeerConnection(s.config)
	if err != nil {
		return nil, fmt.Errorf("failed to create peer connection: %w", err)
	}

	// Create H.264 video track
	videoTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeH264,
			ClockRate: h264ClockRate,
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

	// Create client
	client := &Client{
		id:         generateClientID(),
		peerConn:   peerConn,
		videoTrack: videoTrack,
		frameChan:  make(chan *types.H264Frame, 30), // Buffer 1 second worth
		closeChan:  make(chan struct{}),
	}

	// Handle ICE connection state changes
	peerConn.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("[WebRTC] Client %s ICE state: %s", client.id, state.String())
		if state == webrtc.ICEConnectionStateFailed ||
			state == webrtc.ICEConnectionStateClosed {
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

	// Set local description (answer)
	if err := peerConn.SetLocalDescription(answer); err != nil {
		peerConn.Close()
		return nil, fmt.Errorf("failed to set local description: %w", err)
	}

	// Add client to server
	s.clientsMu.Lock()
	s.clients[client.id] = client
	s.clientsMu.Unlock()

	// Start frame sender goroutine
	go s.sendFrames(client)

	log.Printf("[WebRTC] Client %s connected", client.id)

	// Return answer as JSON
	answerJSON, err := json.Marshal(answer)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal answer: %w", err)
	}

	return answerJSON, nil
}

// SendFrame sends a frame to all connected clients
func (s *Server) SendFrame(frame *types.H264Frame) {
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()

	for _, client := range s.clients {
		// Non-blocking send
		select {
		case client.frameChan <- frame:
			client.framesSent++
		default:
			// Channel full, drop frame
			client.framesDropped++
		}
	}
}

// sendFrames sends frames to a specific client
func (s *Server) sendFrames(client *Client) {
	for {
		select {
		case <-client.closeChan:
			return

		case frame := <-client.frameChan:
			// Calculate timestamp (assuming 30fps)
			// timestamp = frame_num * (clock_rate / fps)
			timestamp := frame.FrameNum * (h264ClockRate / 30)

			// Write H.264 sample to track
			if err := client.videoTrack.WriteSample(media.Sample{
				Data:     frame.Data,
				Duration: time.Second / 30,
			}); err != nil {
				if err != io.ErrClosedPipe {
					log.Printf("[WebRTC] Error writing sample for client %s: %v", client.id, err)
				}
				return
			}

			_ = timestamp // Timestamp is handled by pion internally
		}
	}
}

// RemoveClient removes a client by ID
func (s *Server) RemoveClient(clientID string) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	client, exists := s.clients[clientID]
	if !exists {
		return
	}

	// Close client
	close(client.closeChan)
	close(client.frameChan)
	client.peerConn.Close()

	delete(s.clients, clientID)

	log.Printf("[WebRTC] Client %s disconnected (sent: %d, dropped: %d)",
		clientID, client.framesSent, client.framesDropped)
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
			"frames_sent":    client.framesSent,
			"frames_dropped": client.framesDropped,
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
