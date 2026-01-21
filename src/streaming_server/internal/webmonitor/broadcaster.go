package webmonitor

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
	pb "github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/proto"
	"google.golang.org/protobuf/proto"
)

// FrameBroadcaster manages fanout of JPEG frames to multiple clients.
type FrameBroadcaster struct {
	mu        sync.Mutex
	clients   map[int]chan []byte
	nextID    int
	shm       *shmReader
	monitor   *Monitor
	stop      chan struct{}
	stopped   bool
	skipCount int // Count of frames skipped when no clients
}

// NewFrameBroadcaster creates a broadcaster that generates overlay frames and fans them out.
func NewFrameBroadcaster(shm *shmReader, monitor *Monitor) *FrameBroadcaster {
	return &FrameBroadcaster{
		clients: make(map[int]chan []byte),
		shm:     shm,
		monitor: monitor,
		stop:    make(chan struct{}),
	}
}

// Subscribe adds a new client and returns a channel for receiving frames.
func (fb *FrameBroadcaster) Subscribe() (int, <-chan []byte) {
	fb.mu.Lock()
	defer fb.mu.Unlock()

	id := fb.nextID
	fb.nextID++
	ch := make(chan []byte, 2) // Buffer 2 frames to avoid blocking
	fb.clients[id] = ch

	logger.Debug("FrameBroadcaster", "Client #%d subscribed (total clients: %d)", id, len(fb.clients))
	return id, ch
}

// Unsubscribe removes a client.
func (fb *FrameBroadcaster) Unsubscribe(id int) {
	fb.mu.Lock()
	defer fb.mu.Unlock()

	if ch, ok := fb.clients[id]; ok {
		close(ch)
		delete(fb.clients, id)
		logger.Debug("FrameBroadcaster", "Client #%d unsubscribed (remaining clients: %d)", id, len(fb.clients))

		// Alert when no clients remain (frame generation will be skipped)
		if len(fb.clients) == 0 {
			logger.Info("FrameBroadcaster", "No clients remaining - frame generation will be skipped")
		}
	}
}

// Start begins the frame generation and broadcast loop.
func (fb *FrameBroadcaster) Start() {
	go fb.run()
}

// Stop halts the broadcaster.
func (fb *FrameBroadcaster) Stop() {
	fb.mu.Lock()
	if !fb.stopped {
		close(fb.stop)
		fb.stopped = true
	}
	fb.mu.Unlock()
}

func (fb *FrameBroadcaster) run() {
	for {
		select {
		case <-fb.stop:
			return
		default:
		}

		// OPTIMIZATION: Check client count BEFORE consuming semaphore
		// This avoids unnecessary semaphore operations when no clients are connected
		fb.mu.Lock()
		clientCount := len(fb.clients)
		fb.mu.Unlock()

		if clientCount == 0 {
			// No clients - sleep instead of consuming semaphores (reduces CPU usage)
			fb.skipCount++
			if fb.skipCount%10 == 0 {
				logger.Debug("FrameBroadcaster", "No clients connected, sleeping (idle for %d cycles)", fb.skipCount)
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}

		// Reset skip counter when clients are present
		fb.skipCount = 0

		// Wait for new frame via semaphore (blocks until frame available)
		if fb.shm == nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}

		if err := fb.shm.WaitNewFrame(); err != nil {
			// sem_wait failed (e.g., interrupted), retry
			continue
		}

		// Generate overlay frame (semaphore guarantees new frame)
		jpegData := fb.generateOverlay()
		if jpegData == nil {
			continue
		}

		// Broadcast to all clients
		fb.broadcast(jpegData)
	}
}

func (fb *FrameBroadcaster) generateOverlay() []byte {
	if fb.shm == nil {
		return nil
	}

	// Zero-copy: Get frame reference without copying
	frame, ok := fb.shm.LatestFrameZeroCopy()
	if !ok {
		return nil
	}

	// Get latest detection
	fb.monitor.mu.Lock()
	fb.monitor.refreshFromSharedMemoryLocked()
	var detections []Detection
	if fb.monitor.latestDetection != nil {
		detections = fb.monitor.latestDetection.Detections
	}
	fb.monitor.mu.Unlock()

	// Handle different frame formats
	switch frame.Format {
	case 1: // NV12 - TRUE ZERO-COPY: draw directly on shared memory (MJPEG dedicated, destructive OK)
		// Draw stats text with background (white text on black background)
		// Use JST (Asia/Tokyo) for display instead of system local time
		jst := time.FixedZone("JST", 9*3600)
		timeStr := frame.Timestamp.In(jst).Format("2006/01/02 15:04:05")
		stats := fmt.Sprintf("Frame: %d  Time: %s", frame.FrameNumber, timeStr)
		drawTextWithBackgroundNV12(frame.Data, frame.Width, frame.Height,
			10, 10, stats, 255, 16, 2) // White text (Y=255), Black bg (Y=16)

		// Draw bounding boxes and labels
		for _, det := range detections {
			// Bounding box (bright green: Y=200, U=44, V=21)
			drawRectColorNV12(frame.Data, frame.Width, frame.Height,
				det.BBox.X, det.BBox.Y, det.BBox.W, det.BBox.H,
				200, 44, 21, 3) // Bright green YUV values

			// Label above bounding box (bright green text on black background)
			label := fmt.Sprintf("%.2f", det.Confidence)
			labelY := det.BBox.Y - 20
			if labelY < 5 {
				labelY = det.BBox.Y + det.BBox.H + 5
			}
			// Note: Text is Y-plane only, so we use bright Y value (200) for visibility
			drawTextWithBackgroundNV12(frame.Data, frame.Width, frame.Height,
				det.BBox.X, labelY, label, 200, 16, 2) // Bright text, Black bg
		}

		// Convert NV12 (with overlay) to JPEG
		jpegData, err := nv12ToJPEG(frame.Data, frame.Width, frame.Height)
		if err != nil {
			return nil
		}
		return jpegData

	case 0: // JPEG - fallback: return as-is (no overlay)
		return frame.Data

	default:
		return nil
	}
}

func (fb *FrameBroadcaster) broadcast(data []byte) {
	fb.mu.Lock()
	defer fb.mu.Unlock()

	for id, ch := range fb.clients {
		select {
		case ch <- data:
			// Sent successfully
		default:
			// Client too slow, skip this frame for this client
			_ = id // Just to note we're intentionally skipping
		}
	}
}

// SerializedEvent holds pre-serialized data in both formats.
// This avoids redundant serialization when broadcasting to multiple clients.
type SerializedEvent struct {
	JSONData     []byte // Pre-serialized JSON
	ProtobufData []byte // Pre-serialized Protobuf (base64 encoded for SSE)
}

// DetectionBroadcaster manages fanout of detection events to multiple SSE clients.
// Pre-serializes both JSON and Protobuf formats for efficiency.
type DetectionBroadcaster struct {
	mu               sync.Mutex
	clients          map[int]chan *SerializedEvent // Channel carries pre-serialized data
	nextID           int
	shm              *shmReader
	monitor          *Monitor
	stop             chan struct{}
	stopped          bool
	lastEventVersion int // Track last sent version to avoid duplicates
}

// NewDetectionBroadcaster creates a broadcaster for detection events.
func NewDetectionBroadcaster(shm *shmReader, monitor *Monitor) *DetectionBroadcaster {
	return &DetectionBroadcaster{
		clients: make(map[int]chan *SerializedEvent),
		shm:     shm,
		monitor: monitor,
		stop:    make(chan struct{}),
	}
}

// Subscribe adds a new client and returns a channel for receiving detection events.
func (db *DetectionBroadcaster) Subscribe() (int, <-chan *SerializedEvent) {
	db.mu.Lock()
	defer db.mu.Unlock()

	id := db.nextID
	db.nextID++
	ch := make(chan *SerializedEvent, 2) // Buffer 2 events to avoid blocking
	db.clients[id] = ch

	logger.Debug("DetectionBroadcaster", "Client #%d subscribed (total clients: %d)", id, len(db.clients))
	return id, ch
}

// Unsubscribe removes a client.
func (db *DetectionBroadcaster) Unsubscribe(id int) {
	db.mu.Lock()
	defer db.mu.Unlock()

	if ch, ok := db.clients[id]; ok {
		close(ch)
		delete(db.clients, id)
		logger.Debug("DetectionBroadcaster", "Client #%d unsubscribed (remaining clients: %d)", id, len(db.clients))
	}
}

// Start begins the detection event loop.
func (db *DetectionBroadcaster) Start() {
	go db.run()
}

// Stop halts the broadcaster.
func (db *DetectionBroadcaster) Stop() {
	db.mu.Lock()
	if !db.stopped {
		close(db.stop)
		db.stopped = true
	}
	db.mu.Unlock()
}

func (db *DetectionBroadcaster) run() {
	logger.Info("DetectionBroadcaster", "Starting detection event broadcaster...")

	// Wait for detection daemon to initialize
	logger.Info("DetectionBroadcaster", "Waiting for detection daemon initialization...")
	startupRetries := 0
	const maxStartupRetries = 60 // 60 seconds max

	for {
		select {
		case <-db.stop:
			return
		default:
		}

		if db.shm == nil {
			time.Sleep(1 * time.Second)
			continue
		}

		// Check if detection daemon has written at least once
		if det, ok := db.shm.LatestDetection(); ok && det.Version > 0 {
			logger.Info("DetectionBroadcaster", "Detection daemon initialized (version=%d)", det.Version)
			db.lastEventVersion = det.Version
			break
		}

		startupRetries++
		if startupRetries >= maxStartupRetries {
			logger.Warn("DetectionBroadcaster", "Timeout waiting for detection daemon, will keep trying...")
			startupRetries = 0 // Reset and keep trying
		}

		time.Sleep(1 * time.Second)
	}

	// Enter event-driven mode with semaphore
	logger.Info("DetectionBroadcaster", "Entering event-driven mode (semaphore-based)")

	errorCount := 0
	const maxConsecutiveErrors = 10

	idleCount := 0

	for {
		select {
		case <-db.stop:
			return
		default:
		}

		if db.shm == nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}

		// OPTIMIZATION: Check client count BEFORE consuming semaphore
		// This avoids unnecessary semaphore operations when no clients are connected
		db.mu.Lock()
		clientCount := len(db.clients)
		db.mu.Unlock()

		if clientCount == 0 {
			// No clients - sleep instead of consuming semaphores (reduces CPU usage)
			idleCount++
			if idleCount%10 == 0 {
				logger.Debug("DetectionBroadcaster", "No clients connected, sleeping (idle for %d cycles)", idleCount)
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}

		// Reset idle counter when clients are present
		if idleCount > 0 {
			logger.Debug("DetectionBroadcaster", "Client connected, resuming event-driven mode")
			idleCount = 0
		}

		// Wait for semaphore signal (blocks until new detection)
		err := db.shm.WaitNewDetection()
		if err != nil {
			errorCount++

			// Log first error
			if errorCount == 1 {
				logger.Warn("DetectionBroadcaster", "Semaphore wait error: %v", err)
			}

			// If too many errors, fall back to polling temporarily
			if errorCount >= maxConsecutiveErrors {
				logger.Error("DetectionBroadcaster", "Too many semaphore errors (%d), falling back to polling for 10 seconds", errorCount)

				// Polling fallback mode
				ticker := time.NewTicker(100 * time.Millisecond)
				for i := 0; i < 100; i++ { // 10 seconds
					select {
					case <-db.stop:
						ticker.Stop()
						return
					case <-ticker.C:
						db.monitor.mu.Lock()
						db.monitor.refreshFromSharedMemoryLocked()

						if db.monitor.latestDetection != nil && db.lastEventVersion != db.monitor.latestDetection.Version {
							det := db.monitor.latestDetection
							db.lastEventVersion = det.Version
							db.monitor.mu.Unlock()
							db.processAndBroadcast(det)
						} else {
							db.monitor.mu.Unlock()
						}
					}
				}
				ticker.Stop()

				errorCount = 0
				logger.Info("DetectionBroadcaster", "Retrying event-driven mode...")
			} else {
				time.Sleep(100 * time.Millisecond)
			}
			continue
		}

		// Success - reset error counter
		if errorCount > 0 {
			logger.Info("DetectionBroadcaster", "Semaphore recovered after %d errors", errorCount)
			errorCount = 0
		}

		// Semaphore signaled - read and broadcast
		db.monitor.mu.Lock()
		db.monitor.refreshFromSharedMemoryLocked()

		if db.monitor.latestDetection != nil && db.lastEventVersion != db.monitor.latestDetection.Version {
			det := db.monitor.latestDetection
			db.lastEventVersion = det.Version
			db.monitor.mu.Unlock()

			// Only broadcast if there are actual detections (safety filter)
			// YOLO detector already filters empty results, but double-check here
			if len(det.Detections) > 0 {
				db.processAndBroadcast(det)
			}
		} else {
			db.monitor.mu.Unlock()
		}
	}
}

// processAndBroadcast pre-serializes detection result to both formats and broadcasts
func (db *DetectionBroadcaster) processAndBroadcast(det *DetectionResult) {
	// Serialize to JSON (direct from Go struct - no Protobuf intermediate)
	jsonEvent := map[string]interface{}{
		"frame_number": det.FrameNumber,
		"timestamp":    det.Timestamp,
		"detections":   convertDetectionsToJSON(det.Detections),
	}
	jsonData, err := json.Marshal(jsonEvent)
	if err != nil {
		logger.Error("DetectionBroadcaster", "JSON marshal error: %v", err)
		return
	}

	// Serialize to Protobuf
	pbEvent := &pb.DetectionEvent{
		FrameNumber: uint64(det.FrameNumber),
		Timestamp:   det.Timestamp,
		Detections:  convertDetectionsToProto(det.Detections),
	}
	pbData, err := proto.Marshal(pbEvent)
	if err != nil {
		logger.Error("DetectionBroadcaster", "Protobuf marshal error: %v", err)
		return
	}

	// Base64 encode for SSE transport
	pbBase64 := []byte(base64.StdEncoding.EncodeToString(pbData))

	// Broadcast pre-serialized event
	db.broadcast(&SerializedEvent{
		JSONData:     jsonData,
		ProtobufData: pbBase64,
	})
}

// convertDetectionsToJSON converts detections to JSON-compatible format
func convertDetectionsToJSON(detections []Detection) []map[string]interface{} {
	result := make([]map[string]interface{}, len(detections))
	for i, d := range detections {
		result[i] = map[string]interface{}{
			"bbox": map[string]int{
				"x": d.BBox.X,
				"y": d.BBox.Y,
				"w": d.BBox.W,
				"h": d.BBox.H,
			},
			"confidence": d.Confidence,
			"class_id":   0,
			"class_name": d.ClassName,
		}
	}
	return result
}

// convertDetectionsToProto converts detections to Protobuf format
func convertDetectionsToProto(detections []Detection) []*pb.Detection {
	result := make([]*pb.Detection, len(detections))
	for i, d := range detections {
		result[i] = &pb.Detection{
			Bbox: &pb.BBox{
				X: int32(d.BBox.X),
				Y: int32(d.BBox.Y),
				W: int32(d.BBox.W),
				H: int32(d.BBox.H),
			},
			Confidence: float32(d.Confidence),
			ClassId:    0,
			Label:      d.ClassName,
		}
	}
	return result
}

func (db *DetectionBroadcaster) broadcast(event *SerializedEvent) {
	db.mu.Lock()
	defer db.mu.Unlock()

	for id, ch := range db.clients {
		select {
		case ch <- event:
			// Sent successfully
		default:
			// Client too slow, skip this event for this client
			_ = id
		}
	}
}

// StatusBroadcaster manages fanout of status events to multiple SSE clients.
// Pre-serializes both JSON and Protobuf formats for efficiency.
type StatusBroadcaster struct {
	mu       sync.Mutex
	clients  map[int]chan *SerializedEvent // Channel carries pre-serialized data
	nextID   int
	shm      *shmReader
	monitor  *Monitor
	stop     chan struct{}
	stopped  bool
	interval time.Duration
}

// NewStatusBroadcaster creates a broadcaster for status events.
func NewStatusBroadcaster(shm *shmReader, monitor *Monitor, interval time.Duration) *StatusBroadcaster {
	return &StatusBroadcaster{
		clients:  make(map[int]chan *SerializedEvent),
		shm:      shm,
		monitor:  monitor,
		stop:     make(chan struct{}),
		interval: interval,
	}
}

// Subscribe adds a new client and returns a channel for receiving status events.
func (sb *StatusBroadcaster) Subscribe() (int, <-chan *SerializedEvent) {
	sb.mu.Lock()
	defer sb.mu.Unlock()

	id := sb.nextID
	sb.nextID++
	ch := make(chan *SerializedEvent, 2) // Buffer 2 events to avoid blocking
	sb.clients[id] = ch

	logger.Debug("StatusBroadcaster", "Client #%d subscribed (total clients: %d)", id, len(sb.clients))
	return id, ch
}

// Unsubscribe removes a client.
func (sb *StatusBroadcaster) Unsubscribe(id int) {
	sb.mu.Lock()
	defer sb.mu.Unlock()

	if ch, ok := sb.clients[id]; ok {
		close(ch)
		delete(sb.clients, id)
		logger.Debug("StatusBroadcaster", "Client #%d unsubscribed (remaining clients: %d)", id, len(sb.clients))
	}
}

// Start begins the status event loop.
func (sb *StatusBroadcaster) Start() {
	go sb.run()
}

// Stop halts the broadcaster.
func (sb *StatusBroadcaster) Stop() {
	sb.mu.Lock()
	if !sb.stopped {
		close(sb.stop)
		sb.stopped = true
	}
	sb.mu.Unlock()
}

func (sb *StatusBroadcaster) run() {
	logger.Info("StatusBroadcaster", "Starting status event broadcaster (interval=%v)...", sb.interval)
	ticker := time.NewTicker(sb.interval)
	defer ticker.Stop()

	for {
		select {
		case <-sb.stop:
			return
		case <-ticker.C:
			// Check client count before generating status
			sb.mu.Lock()
			clientCount := len(sb.clients)
			sb.mu.Unlock()

			if clientCount == 0 {
				continue
			}

			// Generate and broadcast pre-serialized status event
			event := sb.generateSerializedEvent()
			if event != nil {
				sb.broadcast(event)
			}
		}
	}
}

func (sb *StatusBroadcaster) generateSerializedEvent() *SerializedEvent {
	// Get snapshot from monitor
	monitorStats, shmStats, latest, history := sb.monitor.Snapshot()
	timestamp := float64(time.Now().Unix())

	// Build JSON directly from Go structs (no Protobuf intermediate)
	jsonEvent := sb.buildJSONStatus(monitorStats, shmStats, latest, history, timestamp)
	jsonData, err := json.Marshal(jsonEvent)
	if err != nil {
		logger.Error("StatusBroadcaster", "JSON marshal error: %v", err)
		return nil
	}

	// Build Protobuf
	pbEvent := sb.buildProtoStatus(monitorStats, shmStats, latest, history, timestamp)
	pbData, err := proto.Marshal(pbEvent)
	if err != nil {
		logger.Error("StatusBroadcaster", "Protobuf marshal error: %v", err)
		return nil
	}

	// Base64 encode for SSE transport
	pbBase64 := []byte(base64.StdEncoding.EncodeToString(pbData))

	return &SerializedEvent{
		JSONData:     jsonData,
		ProtobufData: pbBase64,
	}
}

func (sb *StatusBroadcaster) buildJSONStatus(
	monitorStats MonitorStats,
	shmStats SharedMemoryStats,
	latest *DetectionResult,
	history []DetectionResult,
	timestamp float64,
) map[string]interface{} {
	// Monitor stats
	jsonMonitor := map[string]interface{}{
		"frames_processed": monitorStats.FramesProcessed,
		"current_fps":      monitorStats.CurrentFPS,
		"detection_count":  monitorStats.DetectionCount,
		"target_fps":       monitorStats.TargetFPS,
	}

	// Shared memory stats
	jsonShmStats := map[string]interface{}{
		"frame_count":          shmStats.FrameCount,
		"total_frames_written": shmStats.TotalFramesWritten,
		"detection_version":    shmStats.DetectionVersion,
		"has_detection":        shmStats.HasDetection,
	}

	// Latest detection
	var jsonLatest interface{}
	if latest != nil {
		jsonLatest = map[string]interface{}{
			"frame_number":   latest.FrameNumber,
			"timestamp":      latest.Timestamp,
			"num_detections": latest.NumDetections,
			"version":        latest.Version,
			"detections":     convertDetectionsToJSON(latest.Detections),
		}
	}

	// Detection history
	jsonHistory := make([]map[string]interface{}, len(history))
	for i, h := range history {
		jsonHistory[i] = map[string]interface{}{
			"frame_number": h.FrameNumber,
			"timestamp":    h.Timestamp,
			"detections":   convertDetectionsToJSON(h.Detections),
		}
	}

	return map[string]interface{}{
		"monitor":           jsonMonitor,
		"shared_memory":     jsonShmStats,
		"latest_detection":  jsonLatest,
		"detection_history": jsonHistory,
		"timestamp":         timestamp,
	}
}

func (sb *StatusBroadcaster) buildProtoStatus(
	monitorStats MonitorStats,
	shmStats SharedMemoryStats,
	latest *DetectionResult,
	history []DetectionResult,
	timestamp float64,
) *pb.StatusEvent {
	pbMonitor := &pb.MonitorStats{
		FramesProcessed: int32(monitorStats.FramesProcessed),
		CurrentFps:      monitorStats.CurrentFPS,
		DetectionCount:  int32(monitorStats.DetectionCount),
		TargetFps:       int32(monitorStats.TargetFPS),
	}

	pbShmStats := &pb.SharedMemoryStats{
		FrameCount:         int32(shmStats.FrameCount),
		TotalFramesWritten: int32(shmStats.TotalFramesWritten),
		DetectionVersion:   int32(shmStats.DetectionVersion),
		HasDetection:       int32(shmStats.HasDetection),
	}

	var pbLatest *pb.DetectionResult
	if latest != nil {
		pbLatest = convertDetectionResultToProto(latest)
	}

	pbHistory := make([]*pb.DetectionResult, len(history))
	for i, h := range history {
		pbHistory[i] = convertDetectionResultToProto(&h)
	}

	return &pb.StatusEvent{
		Monitor:          pbMonitor,
		SharedMemory:     pbShmStats,
		LatestDetection:  pbLatest,
		DetectionHistory: pbHistory,
		Timestamp:        timestamp,
	}
}

// convertDetectionResultToProto converts DetectionResult to pb.DetectionResult
func convertDetectionResultToProto(det *DetectionResult) *pb.DetectionResult {
	pbDetections := make([]*pb.Detection, len(det.Detections))
	for i, d := range det.Detections {
		pbDetections[i] = &pb.Detection{
			Bbox: &pb.BBox{
				X: int32(d.BBox.X),
				Y: int32(d.BBox.Y),
				W: int32(d.BBox.W),
				H: int32(d.BBox.H),
			},
			Confidence: float32(d.Confidence),
			ClassId:    0,
			Label:      d.ClassName,
		}
	}

	return &pb.DetectionResult{
		FrameNumber:   uint64(det.FrameNumber),
		Timestamp:     det.Timestamp,
		NumDetections: int32(det.NumDetections),
		Version:       int32(det.Version),
		Detections:    pbDetections,
	}
}

// convertDetectionEventToProto converts DetectionEvent to pb.DetectionEvent
func convertDetectionEventToProto(det *DetectionEvent) *pb.DetectionEvent {
	pbDetections := make([]*pb.Detection, len(det.Detections))
	for i, d := range det.Detections {
		pbDetections[i] = &pb.Detection{
			Bbox: &pb.BBox{
				X: int32(d.BBox.X),
				Y: int32(d.BBox.Y),
				W: int32(d.BBox.W),
				H: int32(d.BBox.H),
			},
			Confidence: float32(d.Confidence),
			ClassId:    0,
			Label:      d.ClassName,
		}
	}

	return &pb.DetectionEvent{
		FrameNumber: uint64(det.FrameNumber),
		Timestamp:   det.Timestamp,
		Detections:  pbDetections,
	}
}

// convertDetectionResultToEvent converts DetectionResult to pb.DetectionEvent (for history)
func convertDetectionResultToEvent(det *DetectionResult) *pb.DetectionEvent {
	pbDetections := make([]*pb.Detection, len(det.Detections))
	for i, d := range det.Detections {
		pbDetections[i] = &pb.Detection{
			Bbox: &pb.BBox{
				X: int32(d.BBox.X),
				Y: int32(d.BBox.Y),
				W: int32(d.BBox.W),
				H: int32(d.BBox.H),
			},
			Confidence: float32(d.Confidence),
			ClassId:    0,
			Label:      d.ClassName,
		}
	}

	return &pb.DetectionEvent{
		FrameNumber: uint64(det.FrameNumber),
		Timestamp:   det.Timestamp,
		Detections:  pbDetections,
	}
}

func (sb *StatusBroadcaster) broadcast(event *SerializedEvent) {
	sb.mu.Lock()
	defer sb.mu.Unlock()

	for id, ch := range sb.clients {
		select {
		case ch <- event:
			// Sent successfully
		default:
			// Client too slow, skip this event for this client
			_ = id
		}
	}
}
