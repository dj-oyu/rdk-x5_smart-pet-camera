package webmonitor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Server serves the Go-based web monitor endpoints.
type Server struct {
	cfg                    Config
	monitor                *Monitor
	recorder               *H264Recorder
	webrtc                 *http.Client
	broadcaster            *FrameBroadcaster
	detectionBroadcaster   *DetectionBroadcaster
	statusBroadcaster      *StatusBroadcaster
	connectionBroadcaster  *ConnectionBroadcaster
	comicCapture           *ComicCapture
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

	// Build WebRTC client count URL
	webrtcCountURL := strings.TrimRight(cfg.WebRTCBaseURL, "/") + "/api/clients/count"

	// Create ConnectionBroadcaster first to get the onChange channel
	connectionBroadcaster, onChange := NewConnectionBroadcaster(webrtcCountURL)

	// Create other broadcasters with the onChange channel for notifications
	broadcaster := NewFrameBroadcaster(shm, monitor, onChange)
	broadcaster.Start()

	detectionBroadcaster := NewDetectionBroadcaster(shm, monitor, onChange)
	detectionBroadcaster.Start()

	statusBroadcaster := NewStatusBroadcaster(shm, monitor, cfg.StatusInterval, onChange)
	statusBroadcaster.Start()

	// Wire up ConnectionBroadcaster with references to other broadcasters
	connectionBroadcaster.SetBroadcasters(broadcaster, detectionBroadcaster, statusBroadcaster)
	connectionBroadcaster.Start()

	// Initialize H.264 recorder with SHM name
	h264ShmName := cfg.H264ShmName
	if h264ShmName == "" {
		h264ShmName = "/pet_camera_stream"
	}

	recorder := NewH264Recorder(cfg.RecordingOutputPath, h264ShmName)

	// Wire up detection callback for recording thumbnail
	detectionBroadcaster.SetOnDetection(func() {
		recorder.NotifyDetection()
	})

	// Initialize comic capture with its own SHM reader (independent version tracking)
	var comicCapture *ComicCapture
	if comicShm, err := newSHMReader(cfg.FrameShmName, cfg.DetectionShmName); err == nil {
		comicsDir := filepath.Join(cfg.RecordingOutputPath, "comics")
		comicCapture = NewComicCapture(comicShm, comicsDir)
		comicCapture.Start()
	}

	return &Server{
		cfg:                   cfg,
		monitor:               monitor,
		recorder:              recorder,
		webrtc:                &http.Client{Timeout: 5 * time.Second},
		broadcaster:           broadcaster,
		detectionBroadcaster:  detectionBroadcaster,
		statusBroadcaster:     statusBroadcaster,
		connectionBroadcaster: connectionBroadcaster,
		comicCapture:          comicCapture,
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
	mux.HandleFunc("/api/connections", s.handleConnections)
	mux.HandleFunc("/api/connections/stream", s.handleConnectionsStream)
	mux.HandleFunc("/api/camera_status", s.handleCameraStatus)
	mux.HandleFunc("/api/debug/switch-camera", s.handleCameraSwitch)
	mux.HandleFunc("/api/recording/start", s.handleRecordingStart)
	mux.HandleFunc("/api/recording/stop", s.handleRecordingStop)
	mux.HandleFunc("/api/recording/status", s.handleRecordingStatus)
	mux.HandleFunc("/api/recording/heartbeat", s.handleRecordingHeartbeat)
	mux.HandleFunc("/api/recordings", s.handleRecordingsList)
	mux.HandleFunc("/api/recordings/", s.handleRecordingDownload)
	mux.HandleFunc("/api/webrtc/offer", s.handleWebRTCOffer)
	mux.HandleFunc("/api/comics", s.handleComicsList)
	mux.HandleFunc("/api/comics/", s.handleComicServe)

	return mux
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	// Serve index.html from assets directory (supports LSP in editor)
	indexPath := filepath.Join(s.cfg.AssetsDir, "index.html")
	http.ServeFile(w, r, indexPath)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	id, frameCh := s.broadcaster.Subscribe()
	defer s.broadcaster.Unsubscribe(id)
	streamMJPEGFromChannel(w, r, frameCh)
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
	// Subscribe to status events
	id, eventCh := s.statusBroadcaster.Subscribe()
	defer s.statusBroadcaster.Unsubscribe(id)

	// Content negotiation: supports both query param and Accept header
	// Query param: ?format=protobuf (for EventSource which can't set headers)
	// Accept header: application/protobuf (for fetch API)
	useProtobuf := false

	// Check query parameter first (enables EventSource + Protobuf)
	if r.URL.Query().Get("format") == "protobuf" {
		useProtobuf = true
	} else {
		// Fall back to Accept header
		accept := r.Header.Get("Accept")
		if strings.Contains(accept, "application/protobuf") ||
			strings.Contains(accept, "application/x-protobuf") {
			useProtobuf = true
		}
	}

	// Stream events from channel with appropriate format
	streamStatusEventsFromChannel(w, r, eventCh, useProtobuf)
}

func (s *Server) handleDetectionsStream(w http.ResponseWriter, r *http.Request) {
	// Subscribe to detection events
	id, eventCh := s.detectionBroadcaster.Subscribe()
	defer s.detectionBroadcaster.Unsubscribe(id)

	// Content negotiation: supports both query param and Accept header
	// Query param: ?format=protobuf (for EventSource which can't set headers)
	// Accept header: application/protobuf (for fetch API)
	useProtobuf := false

	// Check query parameter first (enables EventSource + Protobuf)
	if r.URL.Query().Get("format") == "protobuf" {
		useProtobuf = true
	} else {
		// Fall back to Accept header
		accept := r.Header.Get("Accept")
		if strings.Contains(accept, "application/protobuf") ||
			strings.Contains(accept, "application/x-protobuf") {
			useProtobuf = true
		}
	}

	// Stream events from channel with appropriate format
	streamDetectionEventsFromChannel(w, r, eventCh, useProtobuf)
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

	filename, err := s.recorder.Start()
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

func (s *Server) handleRecordingHeartbeat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ok := s.recorder.Heartbeat()
	if !ok {
		writeJSONWithStatus(w, map[string]any{"error": "not recording"}, http.StatusBadRequest)
		return
	}

	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handleRecordingsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	recordings, err := s.recorder.ListRecordings()
	if err != nil {
		writeJSONWithStatus(w, map[string]any{"error": err.Error()}, http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{"recordings": recordings})
}

func (s *Server) handleRecordingDownload(w http.ResponseWriter, r *http.Request) {
	// Extract path parts: /api/recordings/{filename} or /api/recordings/{filename}/thumbnail
	path := r.URL.Path
	prefix := "/api/recordings/"
	if !strings.HasPrefix(path, prefix) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	pathRest := strings.TrimPrefix(path, prefix)
	if pathRest == "" {
		http.Error(w, "Filename required", http.StatusBadRequest)
		return
	}

	// Check if this is a thumbnail regeneration request
	pathParts := strings.Split(pathRest, "/")
	if len(pathParts) == 2 && pathParts[1] == "thumbnail" {
		s.handleThumbnailRegenerate(w, r, pathParts[0])
		return
	}

	filename := pathParts[0]

	if r.Method != http.MethodGet && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if r.Method == http.MethodDelete {
		if err := s.recorder.DeleteRecording(filename); err != nil {
			writeJSONWithStatus(w, map[string]any{"error": err.Error()}, http.StatusNotFound)
			return
		}
		writeJSON(w, map[string]any{"deleted": true, "filename": filename})
		return
	}

	// GET - download file
	filePath, err := s.recorder.GetRecordingPath(filename)
	if err != nil {
		writeJSONWithStatus(w, map[string]any{"error": err.Error()}, http.StatusNotFound)
		return
	}

	// Set download headers based on file type
	if strings.HasSuffix(filename, ".mp4") {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filename))
		w.Header().Set("Content-Type", "video/mp4")
	} else if strings.HasSuffix(filename, ".h264") {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filename))
		w.Header().Set("Content-Type", "video/h264")
	} else if strings.HasSuffix(filename, ".jpg") {
		w.Header().Set("Content-Type", "image/jpeg")
		// No Content-Disposition = display in browser
	}

	http.ServeFile(w, r, filePath)
}

func (s *Server) handleThumbnailRegenerate(w http.ResponseWriter, r *http.Request, filename string) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Timestamp float64 `json:"timestamp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONWithStatus(w, map[string]any{"error": "invalid request body"}, http.StatusBadRequest)
		return
	}

	if err := s.recorder.RegenerateThumbnail(filename, req.Timestamp); err != nil {
		writeJSONWithStatus(w, map[string]any{"error": err.Error()}, http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]any{
		"success":   true,
		"filename":  filename,
		"timestamp": req.Timestamp,
	})
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

func (s *Server) handleConnections(w http.ResponseWriter, r *http.Request) {
	counts := s.connectionBroadcaster.GetCounts()
	writeJSON(w, counts)
}

func (s *Server) handleConnectionsStream(w http.ResponseWriter, r *http.Request) {
	id, eventCh := s.connectionBroadcaster.Subscribe()
	defer s.connectionBroadcaster.Unsubscribe(id)

	streamConnectionEventsFromChannel(w, r, eventCh)
}

// Shutdown stops background goroutines.
func (s *Server) Shutdown() {
	if s.comicCapture != nil {
		s.comicCapture.Stop()
	}
}

func (s *Server) handleComicsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	comicsDir := filepath.Join(s.cfg.RecordingOutputPath, "comics")
	entries, err := os.ReadDir(comicsDir)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, map[string]any{"comics": []any{}})
			return
		}
		writeJSONWithStatus(w, map[string]any{"error": err.Error()}, http.StatusInternalServerError)
		return
	}

	type comicInfo struct {
		Filename  string `json:"filename"`
		Size      int64  `json:"size"`
		CreatedAt string `json:"created_at"`
	}

	comics := []comicInfo{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jpg") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		comics = append(comics, comicInfo{
			Filename:  e.Name(),
			Size:      info.Size(),
			CreatedAt: info.ModTime().Format(time.RFC3339),
		})
	}

	sort.Slice(comics, func(i, j int) bool {
		return comics[i].CreatedAt > comics[j].CreatedAt
	})

	writeJSON(w, map[string]any{"comics": comics})
}

func (s *Server) handleComicServe(w http.ResponseWriter, r *http.Request) {
	prefix := "/api/comics/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	filename := filepath.Base(strings.TrimPrefix(r.URL.Path, prefix))
	if filename == "" || filename == "." || !strings.HasSuffix(filename, ".jpg") {
		http.Error(w, "Invalid filename", http.StatusBadRequest)
		return
	}

	comicsDir := filepath.Join(s.cfg.RecordingOutputPath, "comics")
	filePath := filepath.Join(comicsDir, filename)

	switch r.Method {
	case http.MethodGet:
		if _, err := os.Stat(filePath); err != nil {
			writeJSONWithStatus(w, map[string]any{"error": "not found"}, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		http.ServeFile(w, r, filePath)
	case http.MethodDelete:
		if err := os.Remove(filePath); err != nil {
			writeJSONWithStatus(w, map[string]any{"error": err.Error()}, http.StatusNotFound)
			return
		}
		writeJSON(w, map[string]any{"deleted": true, "filename": filename})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
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
