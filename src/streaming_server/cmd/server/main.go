package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	_ "net/http/pprof" // Enable pprof
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/h264"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/metrics"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/recorder"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/shm"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/webrtc"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/types"
)

var (
	// Command-line flags
	shmName     = flag.String("shm", "/pet_camera_stream", "Shared memory name")
	httpAddr    = flag.String("http", ":8081", "HTTP server address")
	metricsAddr = flag.String("metrics", ":9090", "Metrics server address")
	pprofAddr   = flag.String("pprof", ":6060", "pprof server address")
	recordPath  = flag.String("record-path", "./recordings", "Recording output path")
	maxClients  = flag.Int("max-clients", 10, "Maximum WebRTC clients")
	stunServers = flag.String("stun", "stun:stun.l.google.com:19302", "STUN server URLs (comma-separated)")
	logLevel    = flag.String("log-level", "info", "Log level (debug, info, warn, error, silent)")
	logColor    = flag.Bool("log-color", true, "Enable colored log output")
)

// Server is the main streaming server
type Server struct {
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	metrics    *metrics.Metrics
	shmReader  *shm.Reader
	processor  *h264.Processor
	webrtc     *webrtc.Server
	recorder   *recorder.Recorder
	httpServer *http.Server

	// Channels for goroutine communication
	processChan  chan *types.H264Frame
	webrtcChan   chan *types.H264Frame
	recorderChan chan *types.H264Frame
}

func main() {
	flag.Parse()

	// Initialize logger
	level, err := logger.ParseLevel(*logLevel)
	if err != nil {
		log.Fatalf("Invalid log level: %v", err)
	}
	logger.Init(level, os.Stderr, *logColor)

	logger.Info("Main", "Streaming server starting...")
	logger.Info("Main", "Log level: %s", level)

	// Create recordings directory
	if err := os.MkdirAll(*recordPath, 0755); err != nil {
		log.Fatalf("Failed to create recordings directory: %v", err)
	}

	// Create server
	srv, err := NewServer()
	if err != nil {
		log.Fatalf("Failed to create server: %v", err)
	}

	// Start server
	if err := srv.Start(); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("Shutting down...")

	// Graceful shutdown
	if err := srv.Shutdown(); err != nil {
		log.Printf("Error during shutdown: %v", err)
	}

	log.Println("Server stopped")
}

// NewServer creates a new streaming server
func NewServer() (*Server, error) {
	ctx, cancel := context.WithCancel(context.Background())

	// Create metrics
	m := metrics.New()

	// Create shared memory reader
	reader, err := shm.NewReader(*shmName)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create shared memory reader: %w", err)
	}

	// Create H.264 processor
	processor := h264.NewProcessor()

	// Create WebRTC server
	stunURLs := []string{*stunServers}
	webrtcSrv := webrtc.NewServer(stunURLs, *maxClients)

	// Create recorder
	rec := recorder.NewRecorder(*recordPath)

	// Create HTTP server
	mux := http.NewServeMux()
	httpServer := &http.Server{
		Addr:    *httpAddr,
		Handler: mux,
	}

	srv := &Server{
		ctx:          ctx,
		cancel:       cancel,
		metrics:      m,
		shmReader:    reader,
		processor:    processor,
		webrtc:       webrtcSrv,
		recorder:     rec,
		httpServer:   httpServer,
		processChan:  make(chan *types.H264Frame, 30),
		webrtcChan:   make(chan *types.H264Frame, 30),
		recorderChan: make(chan *types.H264Frame, 60),
	}

	// Setup HTTP routes
	srv.setupRoutes(mux)

	return srv, nil
}

// Start starts all server components
func (s *Server) Start() error {
	log.Printf("Starting streaming server...")
	log.Printf("  Shared memory: %s", *shmName)
	log.Printf("  HTTP server: %s", *httpAddr)
	log.Printf("  Metrics server: %s", *metricsAddr)
	log.Printf("  pprof server: %s", *pprofAddr)
	log.Printf("  Recording path: %s", *recordPath)

	// Start pprof server
	go func() {
		log.Printf("Starting pprof server on %s", *pprofAddr)
		if err := http.ListenAndServe(*pprofAddr, nil); err != nil {
			log.Printf("pprof server error: %v", err)
		}
	}()

	// Start metrics server
	go func() {
		log.Printf("Starting metrics server on %s", *metricsAddr)
		if err := s.metrics.StartServer(*metricsAddr); err != nil {
			log.Printf("Metrics server error: %v", err)
		}
	}()

	// Start HTTP server
	go func() {
		log.Printf("Starting HTTP server on %s", *httpAddr)
		if err := s.httpServer.ListenAndServe(); err != http.ErrServerClosed {
			log.Printf("HTTP server error: %v", err)
		}
	}()

	// Start goroutines
	s.wg.Add(4)
	go s.readFrames()
	go s.processFrames()
	go s.distributeWebRTC()
	go s.distributeRecorder()

	log.Println("Server started successfully")
	return nil
}

// readFrames reads frames from shared memory (polling-based)
func (s *Server) readFrames() {
	defer s.wg.Done()

	logger.Info("Reader", "Starting frame reading (polling at 30fps)")

	// Poll at 30fps (33.3ms interval)
	ticker := time.NewTicker(33 * time.Millisecond)
	defer ticker.Stop()

	idleCount := 0

	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			// OPTIMIZATION: Skip reading if no clients and not recording
			// This reduces CPU usage when server is idle
			hasClients := s.webrtc.GetClientCount() > 0
			isRecording := s.recorder.IsRecording()

			if !hasClients && !isRecording {
				idleCount++
				if idleCount%30 == 0 {
					logger.Debug("Reader", "No clients and not recording, idle (count=%d)", idleCount)
				}
				continue // Skip reading to reduce CPU usage
			}

			// Reset idle counter when active
			if idleCount > 0 {
				logger.Info("Reader", "Resuming frame reading (clients=%d, recording=%v)",
					s.webrtc.GetClientCount(), isRecording)
				idleCount = 0
			}

			// Read latest frame
			frame, err := s.shmReader.ReadLatest()
			if err != nil {
				s.metrics.ReadErrors.Add(1)
				logger.Warn("Reader", "Read error: %v", err)
				continue
			}

			if frame == nil {
				continue // No new frame
			}

			s.metrics.FramesRead.Add(1)
			s.metrics.UpdateFrameLatency(frame.Timestamp)

			// Send to processor (non-blocking)
			select {
			case s.processChan <- frame:
			default:
				s.metrics.FramesDropped.Add(1)
			}
		}
	}
}

// processFrames processes H.264 frames
func (s *Server) processFrames() {
	defer s.wg.Done()

	for {
		select {
		case <-s.ctx.Done():
			return
		case frame := <-s.processChan:
			startTime := time.Now()

			// Process frame (extract SPS/PPS, detect IDR)
			if err := s.processor.Process(frame); err != nil {
				s.metrics.ProcessErrors.Add(1)
				logger.Warn("Processor", "Error: %v", err)
				continue
			}

			// Don't modify frame data - send original H.264 stream as-is
			// This allows WebRTC to receive the raw stream without duplication

			// Update recorder's header cache when headers are available
			if s.processor.HasHeaders() {
				s.recorder.UpdateHeaders(s.processor.GetSPS(), s.processor.GetPPS())
			}

			s.metrics.FramesProcessed.Add(1)
			s.metrics.UpdateProcessLatency(time.Since(startTime))

			// Send to WebRTC (non-blocking)
			select {
			case s.webrtcChan <- frame:
			default:
				s.metrics.WebRTCFramesDropped.Add(1)
			}

			// Send to recorder (non-blocking)
			select {
			case s.recorderChan <- frame:
			default:
				s.metrics.RecorderFramesDropped.Add(1)
			}

			// Update buffer usage metrics
			s.metrics.UpdateBufferUsage(
				len(s.webrtcChan), cap(s.webrtcChan),
				len(s.recorderChan), cap(s.recorderChan),
			)
		}
	}
}

// distributeWebRTC distributes frames to WebRTC clients
func (s *Server) distributeWebRTC() {
	defer s.wg.Done()

	for {
		select {
		case <-s.ctx.Done():
			return
		case frame := <-s.webrtcChan:
			s.webrtc.SendFrame(frame)
			s.metrics.WebRTCFramesSent.Add(1)
			s.metrics.ActiveClients.Store(uint64(s.webrtc.GetClientCount()))
		}
	}
}

// distributeRecorder distributes frames to recorder
func (s *Server) distributeRecorder() {
	defer s.wg.Done()

	for {
		select {
		case <-s.ctx.Done():
			return
		case frame := <-s.recorderChan:
			if s.recorder.SendFrame(frame) {
				s.metrics.RecorderFramesSent.Add(1)
			}

			// Update recording metrics
			status := s.recorder.GetStatus()
			if status.Recording {
				s.metrics.RecordingActive.Store(1)
				s.metrics.RecordingBytes.Store(status.BytesWritten)
				s.metrics.RecordingFrames.Store(status.FrameCount)
			} else {
				s.metrics.RecordingActive.Store(0)
			}
		}
	}
}

// setupRoutes sets up HTTP routes
func (s *Server) setupRoutes(mux *http.ServeMux) {
	// CORS middleware
	corsMiddleware := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "http://localhost:8080")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}

			next(w, r)
		}
	}

	// WebRTC signaling
	mux.HandleFunc("/offer", corsMiddleware(s.handleOffer))

	// Recording control
	mux.HandleFunc("/start", corsMiddleware(s.handleStartRecording))
	mux.HandleFunc("/stop", corsMiddleware(s.handleStopRecording))
	mux.HandleFunc("/status", corsMiddleware(s.handleStatus))

	// Health check
	mux.HandleFunc("/health", s.handleHealth)
}

// handleOffer handles WebRTC offer
func (s *Server) handleOffer(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	offerJSON, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}

	answerJSON, err := s.webrtc.HandleOffer(offerJSON)
	if err != nil {
		log.Printf("[HTTP] WebRTC offer error: %v", err)
		http.Error(w, fmt.Sprintf("Failed to handle offer: %v", err), http.StatusInternalServerError)
		return
	}

	s.metrics.TotalClients.Add(1)

	w.Header().Set("Content-Type", "application/json")
	w.Write(answerJSON)
}

// handleStartRecording handles start recording request
func (s *Server) handleStartRecording(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := s.recorder.Start(); err != nil {
		http.Error(w, fmt.Sprintf("Failed to start recording: %v", err), http.StatusInternalServerError)
		return
	}

	status := s.recorder.GetStatus()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"status":  status,
	})
}

// handleStopRecording handles stop recording request
func (s *Server) handleStopRecording(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := s.recorder.Stop(); err != nil {
		http.Error(w, fmt.Sprintf("Failed to stop recording: %v", err), http.StatusInternalServerError)
		return
	}

	status := s.recorder.GetStatus()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"status":  status,
	})
}

// handleStatus handles status request
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	status := s.recorder.GetStatus()
	json.NewEncoder(w).Encode(status)
}

// handleHealth handles health check
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":         "ok",
		"webrtc_clients": s.webrtc.GetClientCount(),
		"recording":      s.recorder.IsRecording(),
		"has_headers":    s.processor.HasHeaders(),
	})
}

// Shutdown gracefully shuts down the server
func (s *Server) Shutdown() error {
	// Cancel context to stop goroutines
	s.cancel()

	// Wait for goroutines
	s.wg.Wait()

	// Stop recording if active
	if s.recorder.IsRecording() {
		s.recorder.Stop()
	}

	// Close components
	s.recorder.Close()
	s.webrtc.Close()
	s.shmReader.Close()

	// Shutdown HTTP server
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.httpServer.Shutdown(ctx)
}
