package webmonitor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Server serves the Go-based web monitor endpoints.
type Server struct {
	cfg                  Config
	monitor              *Monitor
	recorder             *RecorderState
	webrtc               *http.Client
	broadcaster          *FrameBroadcaster
	detectionBroadcaster *DetectionBroadcaster
}

// NewServer returns a configured monitor server.
func NewServer(cfg Config) *Server {
	if cfg.TargetFPS <= 0 {
		cfg.TargetFPS = DefaultConfig().TargetFPS
	}
	if cfg.StatusInterval == 0 {
		cfg.StatusInterval = DefaultConfig().StatusInterval
	}
	if cfg.DetectionInterval == 0 {
		cfg.DetectionInterval = DefaultConfig().DetectionInterval
	}
	if cfg.MJPEGInterval == 0 {
		cfg.MJPEGInterval = DefaultConfig().MJPEGInterval
	}
	var shm *shmReader
	if reader, err := newSHMReader(cfg.FrameShmName, cfg.DetectionShmName); err == nil {
		shm = reader
	}

	monitor := NewMonitor(cfg.TargetFPS, shm)
	broadcaster := NewFrameBroadcaster(shm, monitor)
	broadcaster.Start()

	detectionBroadcaster := NewDetectionBroadcaster(shm, monitor)
	detectionBroadcaster.Start()

	return &Server{
		cfg:                  cfg,
		monitor:              monitor,
		recorder:             NewRecorderState(cfg.RecordingOutputPath),
		webrtc:               &http.Client{Timeout: 5 * time.Second},
		broadcaster:          broadcaster,
		detectionBroadcaster: detectionBroadcaster,
	}
}

// Handler exposes the HTTP handler for the server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	assetHandler := newAssetHandler(s.cfg.BuildAssetsDir, s.cfg.AssetsDir)

	mux.HandleFunc("/", s.handleIndex)
	mux.Handle("/assets/", http.StripPrefix("/assets/", assetHandler))
	mux.HandleFunc("/stream", s.handleStream)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/status/stream", s.handleStatusStream)
	mux.HandleFunc("/api/detections/stream", s.handleDetectionsStream)
	mux.HandleFunc("/api/camera_status", s.handleCameraStatus)
	mux.HandleFunc("/api/debug/switch-camera", s.handleCameraSwitch)
	mux.HandleFunc("/api/recording/start", s.handleRecordingStart)
	mux.HandleFunc("/api/recording/stop", s.handleRecordingStop)
	mux.HandleFunc("/api/recording/status", s.handleRecordingStatus)
	mux.HandleFunc("/api/webrtc/offer", s.handleWebRTCOffer)

	return mux
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(indexHTML))
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	id, frameCh := s.broadcaster.Subscribe()
	defer s.broadcaster.Unsubscribe(id)
	streamMJPEGFromChannel(w, frameCh)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	monitorStats, shmStats, latest, history := s.monitor.Snapshot()
	payload := map[string]any{
		"monitor":           monitorStats,
		"shared_memory":     shmStats,
		"latest_detection":  latest,
		"detection_history": history,
		"timestamp":         float64(time.Now().Unix()),
	}
	writeJSON(w, payload)
}

func (s *Server) handleStatusStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ticker := time.NewTicker(s.cfg.StatusInterval)
	defer ticker.Stop()

	for {
		monitorStats, shmStats, latest, history := s.monitor.Snapshot()
		payload := map[string]any{
			"monitor":           monitorStats,
			"shared_memory":     shmStats,
			"latest_detection":  latest,
			"detection_history": history,
			"timestamp":         float64(time.Now().Unix()),
		}
		if err := writeSSE(w, payload); err != nil {
			return
		}
		flusher.Flush()
		<-ticker.C
	}
}

func (s *Server) handleDetectionsStream(w http.ResponseWriter, r *http.Request) {
	// Subscribe to detection events
	id, eventCh := s.detectionBroadcaster.Subscribe()
	defer s.detectionBroadcaster.Unsubscribe(id)

	// Content negotiation based on Accept header
	accept := r.Header.Get("Accept")
	useProtobuf := false

	// Check if client prefers Protobuf
	if strings.Contains(accept, "application/protobuf") ||
		strings.Contains(accept, "application/x-protobuf") {
		useProtobuf = true
	}

	// Stream events from channel with appropriate format
	streamDetectionEventsFromChannel(w, eventCh, useProtobuf)
}

func (s *Server) handleCameraStatus(w http.ResponseWriter, r *http.Request) {
	monitorStats, shmStats, _, _ := s.monitor.Snapshot()
	payload := map[string]any{
		"camera":        map[string]any{"mode": "unavailable"},
		"monitor":       monitorStats,
		"shared_memory": shmStats,
	}
	writeJSON(w, payload)
}

func (s *Server) handleCameraSwitch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSONWithStatus(w, map[string]any{
		"error": "switch controller is not configured",
	}, http.StatusBadRequest)
}

func (s *Server) handleRecordingStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	filename, err := s.recorder.Start("")
	if err != nil {
		writeJSONWithStatus(w, map[string]any{"error": err.Error()}, http.StatusBadRequest)
		return
	}

	payload := map[string]any{
		"status":     "recording",
		"file":       filename,
		"started_at": float64(time.Now().Unix()),
	}
	writeJSON(w, payload)
}

func (s *Server) handleRecordingStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	filename, err := s.recorder.Stop()
	if err != nil {
		writeJSONWithStatus(w, map[string]any{"error": err.Error()}, http.StatusBadRequest)
		return
	}

	payload := map[string]any{
		"status":     "stopped",
		"file":       filename,
		"stats":      s.recorder.Status(),
		"stopped_at": float64(time.Now().Unix()),
	}
	writeJSON(w, payload)
}

func (s *Server) handleRecordingStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.recorder.Status())
}

func (s *Server) handleWebRTCOffer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONWithStatus(w, map[string]any{"error": "Invalid offer data"}, http.StatusBadRequest)
		return
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		writeJSONWithStatus(w, map[string]any{"error": "Invalid offer data"}, http.StatusBadRequest)
		return
	}

	if payload["sdp"] == nil || payload["type"] == nil {
		writeJSONWithStatus(w, map[string]any{"error": "Invalid offer data"}, http.StatusBadRequest)
		return
	}

	baseURL := strings.TrimRight(s.cfg.WebRTCBaseURL, "/")
	targetURL := baseURL + "/offer"
	req, err := http.NewRequest(http.MethodPost, targetURL, bytes.NewReader(body))
	if err != nil {
		writeJSONWithStatus(w, map[string]any{"error": "Go server unavailable"}, http.StatusBadGateway)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.webrtc.Do(req)
	if err != nil {
		writeJSONWithStatus(w, map[string]any{"error": "Go server unavailable"}, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		writeJSONWithStatus(w, map[string]any{"error": "Go server unavailable"}, http.StatusBadGateway)
		return
	}

	if resp.Header.Get("Content-Type") != "" {
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
}

func writeJSON(w http.ResponseWriter, payload any) {
	writeJSONWithStatus(w, payload, http.StatusOK)
}

func writeJSONWithStatus(w http.ResponseWriter, payload any, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		_, _ = fmt.Fprintf(w, `{"error":"%s"}`, err.Error())
	}
}
