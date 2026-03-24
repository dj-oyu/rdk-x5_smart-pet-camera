package webmonitor

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
	pb "github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/proto"
	"google.golang.org/protobuf/proto"
)

// Cached timezone for overlay rendering (avoid allocation per frame)
var jstTimezone = time.FixedZone("JST", 9*3600)

// labelCache holds pre-rendered RGBA label images, keyed by text.
// Re-rendered only when detection version changes.
type labelCache struct {
	labels  []cachedLabel
	version int
}

type cachedLabel struct {
	img  *image.RGBA
	x, y int // Position on NV12 frame
}

// FrameBroadcaster manages fanout of JPEG frames to multiple clients.
type FrameBroadcaster struct {
	mu                 sync.Mutex
	clients            map[int]chan []byte
	nextID             int
	shm                *shmReader
	monitor            *Monitor
	stop               chan struct{}
	stopped            bool
	onChange           chan<- struct{} // Notifies connection count changes
	frameBroadcastBuf  []chan []byte   // Reusable snapshot slice to avoid per-broadcast allocation
	ttLabelCache       labelCache     // TrueType label cache (re-rendered on detection change)
}

// NewFrameBroadcaster creates a broadcaster that generates overlay frames and fans them out.
func NewFrameBroadcaster(shm *shmReader, monitor *Monitor, onChange chan<- struct{}) *FrameBroadcaster {
	return &FrameBroadcaster{
		clients:  make(map[int]chan []byte),
		shm:      shm,
		monitor:  monitor,
		stop:     make(chan struct{}),
		onChange: onChange,
	}
}

// Subscribe adds a new client and returns a channel for receiving frames.
func (fb *FrameBroadcaster) Subscribe() (int, <-chan []byte) {
	fb.mu.Lock()
	id := fb.nextID
	fb.nextID++
	ch := make(chan []byte, 4) // Buffer 4 frames to absorb network jitter
	fb.clients[id] = ch
	logger.Debug("FrameBroadcaster", "Client #%d subscribed (total clients: %d)", id, len(fb.clients))
	fb.mu.Unlock()

	fb.notifyChange()
	return id, ch
}

// Unsubscribe removes a client.
func (fb *FrameBroadcaster) Unsubscribe(id int) {
	fb.mu.Lock()
	removed := false
	if ch, ok := fb.clients[id]; ok {
		close(ch)
		delete(fb.clients, id)
		removed = true
		logger.Debug("FrameBroadcaster", "Client #%d unsubscribed (remaining clients: %d)", id, len(fb.clients))

		if len(fb.clients) == 0 {
			logger.Info("FrameBroadcaster", "No clients remaining - frame generation will be skipped")
		}
	}
	fb.mu.Unlock()

	if removed {
		fb.notifyChange()
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
	// Ticker-based polling at ~30 FPS
	ticker := time.NewTicker(33 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-fb.stop:
			return
		case <-ticker.C:
		}

		fb.mu.Lock()
		clientCount := len(fb.clients)
		fb.mu.Unlock()

		if clientCount == 0 {
			// No clients — save CPU by sleeping instead of polling SHM
			time.Sleep(100 * time.Millisecond)
			continue
		}

		var jpegData []byte
		if fb.shm != nil {
			jpegData = fb.generateOverlay()
		}

		if jpegData == nil {
			continue
		}

		fb.broadcast(jpegData)
	}
}

func (fb *FrameBroadcaster) generateOverlay() []byte {
	if fb.shm == nil {
		return nil
	}

	// Zero-copy: Get frame reference without copying
	frame, ok := fb.shm.LatestFrame()
	if !ok {
		return nil
	}

	// Get latest detection (only if fresh - within 30 frames of current frame)
	fb.monitor.mu.Lock()
	fb.monitor.refreshFromSharedMemoryLocked()
	var detections []Detection
	if fb.monitor.latestDetection != nil {
		// Check if detection is fresh (frame number difference < 30)
		frameDiff := int(frame.FrameNumber) - fb.monitor.latestDetection.FrameNumber
		if frameDiff >= 0 && frameDiff < 30 {
			detections = fb.monitor.latestDetection.Detections
		}
	}
	fb.monitor.mu.Unlock()

	// NV12: draw overlay then HW JPEG encode
	if frame.Format != formatNV12 {
		return frame.Data
	}

	var rects []overlayRect

	// Stats text (bitmap — ASCII only, fast)
	timeStr := frame.Timestamp.In(jstTimezone).Format("2006/01/02 15:04:05")
	stats := fmt.Sprintf("Frame: %d  Time: %s", frame.FrameNumber, timeStr)
	statsTexts := []overlayText{
		{x: 10, y: 10, text: stats, textY: 235, bgY: 16, scale: 2},
	}

	// Detection bboxes (C bitmap — fast rect drawing)
	for _, det := range detections {
		bx := det.BBox.X * frame.Width / 1280
		by := det.BBox.Y * frame.Height / 720
		bw := det.BBox.W * frame.Width / 1280
		bh := det.BBox.H * frame.Height / 720
		rects = append(rects, overlayRect{
			X: bx, Y: by, W: bw, H: bh,
			YVal: 200, UVal: 44, VVal: 21,
			Thickness: 3,
		})
	}

	// Draw stats + bboxes via C bitmap (fast path)
	drawOverlay(frame.Data, frame.Width, frame.Height, rects, statsTexts)

	// TrueType labels: re-render only when detection version changes
	detVersion := 0
	if fb.monitor.latestDetection != nil {
		detVersion = fb.monitor.latestDetection.Version
	}

	if len(detections) == 0 {
		fb.ttLabelCache.labels = fb.ttLabelCache.labels[:0]
		fb.ttLabelCache.version = 0
	} else if detVersion != fb.ttLabelCache.version {
		// Re-render label cache
		fb.ttLabelCache.labels = fb.ttLabelCache.labels[:0]
		fb.ttLabelCache.version = detVersion

		for _, det := range detections {
			bx := det.BBox.X * frame.Width / 1280
			by := det.BBox.Y * frame.Height / 720
			bh := det.BBox.H * frame.Height / 720

			label := fmt.Sprintf("%s %.0f%%", det.ClassName, det.Confidence*100)
			labelImg := RenderLabel(label,
				color.White,
				color.RGBA{R: 0, G: 0, B: 0, A: 180},
				16, // 16pt for MJPEG overlay
			)
			if labelImg == nil {
				continue
			}

			labelY := by - labelImg.Bounds().Dy() - 2
			if labelY < 2 {
				labelY = by + bh + 2
			}
			if labelY > frame.Height-labelImg.Bounds().Dy() {
				labelY = frame.Height - labelImg.Bounds().Dy()
			}
			labelX := bx
			if labelX < 2 {
				labelX = 2
			}

			fb.ttLabelCache.labels = append(fb.ttLabelCache.labels, cachedLabel{
				img: labelImg,
				x:   labelX,
				y:   labelY,
			})
		}
	}

	// Blend cached TrueType labels onto NV12 (fast: ~0.2ms for typical 3-5 labels)
	for _, cl := range fb.ttLabelCache.labels {
		blendRGBAOnNV12(frame.Data, frame.Width, frame.Height, cl.img, cl.x, cl.y)
	}

	jpegData, err := nv12ToJPEG(frame.Data, frame.Width, frame.Height)
	if err != nil {
		return nil
	}
	return jpegData
}

func (fb *FrameBroadcaster) broadcast(data []byte) {
	fb.mu.Lock()
	fb.frameBroadcastBuf = fb.frameBroadcastBuf[:0]
	for _, ch := range fb.clients {
		fb.frameBroadcastBuf = append(fb.frameBroadcastBuf, ch)
	}
	fb.mu.Unlock()

	for _, ch := range fb.frameBroadcastBuf {
		select {
		case ch <- data:
			// Sent successfully
		default:
			// Client too slow, skip this frame for this client
		}
	}
}

// GetClientCount returns the number of connected MJPEG clients.
func (fb *FrameBroadcaster) GetClientCount() int {
	fb.mu.Lock()
	defer fb.mu.Unlock()
	return len(fb.clients)
}

func (fb *FrameBroadcaster) notifyChange() {
	if fb.onChange != nil {
		select {
		case fb.onChange <- struct{}{}:
		default:
			// Non-blocking: if channel is full, skip notification
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
	onChange         chan<- struct{}
	onDetection      func()               // Callback when detection with objects occurs
	onDetectionData  func(*DetectionResult) // Callback with detection data

	// Rate monitoring
	broadcastCount  int
	lastRateLogTime time.Time

	// Empty detection monitoring (observability for 0-detection case)
	emptyUpdateCount int
	lastEmptyLogTime time.Time

	detectionBroadcastBuf []chan *SerializedEvent // Reusable snapshot slice to avoid per-broadcast allocation
}

// NewDetectionBroadcaster creates a broadcaster for detection events.
func NewDetectionBroadcaster(shm *shmReader, monitor *Monitor, onChange chan<- struct{}) *DetectionBroadcaster {
	return &DetectionBroadcaster{
		clients:  make(map[int]chan *SerializedEvent),
		shm:      shm,
		monitor:  monitor,
		stop:     make(chan struct{}),
		onChange: onChange,
	}
}

// SetOnDetection sets a callback that is called when a detection with objects occurs.
// This is used to notify the recorder of the first detection for thumbnail generation.
func (db *DetectionBroadcaster) SetOnDetection(callback func()) {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.onDetection = callback
}

// Subscribe adds a new client and returns a channel for receiving detection events.
func (db *DetectionBroadcaster) Subscribe() (int, <-chan *SerializedEvent) {
	db.mu.Lock()
	id := db.nextID
	db.nextID++
	ch := make(chan *SerializedEvent, 4) // Buffer 4 events to absorb network jitter
	db.clients[id] = ch
	logger.Debug("DetectionBroadcaster", "Client #%d subscribed (total clients: %d)", id, len(db.clients))
	db.mu.Unlock()

	db.notifyChange()
	return id, ch
}

// Unsubscribe removes a client.
func (db *DetectionBroadcaster) Unsubscribe(id int) {
	db.mu.Lock()
	removed := false
	if ch, ok := db.clients[id]; ok {
		close(ch)
		delete(db.clients, id)
		removed = true
		logger.Debug("DetectionBroadcaster", "Client #%d unsubscribed (remaining clients: %d)", id, len(db.clients))
	}
	db.mu.Unlock()

	if removed {
		db.notifyChange()
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
			logger.Warn("DetectionBroadcaster", "Waiting for first detection (detector may be running with 0 detections)...")
			startupRetries = 0 // Reset and keep trying
		}

		time.Sleep(1 * time.Second)
	}

	// Enter event-driven mode via SHM semaphore
	logger.Info("DetectionBroadcaster", "Entering semaphore-driven mode")

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
			logger.Debug("DetectionBroadcaster", "Client connected, resuming polling mode")
			idleCount = 0
		}

		// Wait for detection update via semaphore (event-driven).
		// Replaces 33ms polling: blocks until Python detector posts sem,
		// or 100ms timeout (to re-check stop/client state).
		// Accumulated sem_posts are harmless — version check below skips duplicates.
		db.shm.WaitDetectionUpdate(100) // 100ms timeout
		db.monitor.mu.Lock()
		db.monitor.refreshFromSharedMemoryLocked()

		if db.monitor.latestDetection != nil && db.lastEventVersion != db.monitor.latestDetection.Version {
			det := db.monitor.latestDetection
			db.lastEventVersion = det.Version
			db.monitor.mu.Unlock()

			if len(det.Detections) > 0 {
				db.processAndBroadcast(det)
			} else {
				// Track empty detection updates for observability
				db.emptyUpdateCount++
				now := time.Now()
				if db.lastEmptyLogTime.IsZero() {
					db.lastEmptyLogTime = now
				} else if elapsed := now.Sub(db.lastEmptyLogTime); elapsed >= 10*time.Second {
					logger.Info("DetectionBroadcaster",
						"Detector alive: %d empty updates in %.0fs (YOLO running, 0 detections)",
						db.emptyUpdateCount, elapsed.Seconds())
					db.emptyUpdateCount = 0
					db.lastEmptyLogTime = now
				}
			}
		} else {
			db.monitor.mu.Unlock()
		}
	}
}

// SetOnDetectionData sets a callback that receives the full detection result.
func (db *DetectionBroadcaster) SetOnDetectionData(callback func(*DetectionResult)) {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.onDetectionData = callback
}

// processAndBroadcast pre-serializes detection result to both formats and broadcasts
func (db *DetectionBroadcaster) processAndBroadcast(det *DetectionResult) {
	// Notify callbacks
	db.mu.Lock()
	callback := db.onDetection
	dataCallback := db.onDetectionData
	db.mu.Unlock()
	if callback != nil {
		callback()
	}
	if dataCallback != nil {
		dataCallback(det)
	}

	// Rate monitoring: log every 5 seconds
	db.broadcastCount++
	now := time.Now()
	if db.lastRateLogTime.IsZero() {
		db.lastRateLogTime = now
	} else if elapsed := now.Sub(db.lastRateLogTime); elapsed >= 5*time.Second {
		rate := float64(db.broadcastCount) / elapsed.Seconds()
		logger.Info("DetectionBroadcaster", "Detection rate: %.1f events/sec (%d events in %.1fs)",
			rate, db.broadcastCount, elapsed.Seconds())
		db.broadcastCount = 0
		db.lastRateLogTime = now
	}

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
	db.detectionBroadcastBuf = db.detectionBroadcastBuf[:0]
	for _, ch := range db.clients {
		db.detectionBroadcastBuf = append(db.detectionBroadcastBuf, ch)
	}
	db.mu.Unlock()

	for _, ch := range db.detectionBroadcastBuf {
		select {
		case ch <- event:
			// Sent successfully
		default:
			// Client too slow, skip this event for this client
		}
	}
}

// GetClientCount returns the number of connected detection SSE clients.
func (db *DetectionBroadcaster) GetClientCount() int {
	db.mu.Lock()
	defer db.mu.Unlock()
	return len(db.clients)
}

func (db *DetectionBroadcaster) notifyChange() {
	if db.onChange != nil {
		select {
		case db.onChange <- struct{}{}:
		default:
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
	onChange chan<- struct{}
}

// NewStatusBroadcaster creates a broadcaster for status events.
func NewStatusBroadcaster(shm *shmReader, monitor *Monitor, interval time.Duration, onChange chan<- struct{}) *StatusBroadcaster {
	return &StatusBroadcaster{
		clients:  make(map[int]chan *SerializedEvent),
		shm:      shm,
		monitor:  monitor,
		stop:     make(chan struct{}),
		interval: interval,
		onChange: onChange,
	}
}

// Subscribe adds a new client and returns a channel for receiving status events.
func (sb *StatusBroadcaster) Subscribe() (int, <-chan *SerializedEvent) {
	sb.mu.Lock()
	id := sb.nextID
	sb.nextID++
	ch := make(chan *SerializedEvent, 4) // Buffer 4 events to absorb network jitter
	sb.clients[id] = ch
	logger.Debug("StatusBroadcaster", "Client #%d subscribed (total clients: %d)", id, len(sb.clients))
	sb.mu.Unlock()

	sb.notifyChange()
	return id, ch
}

// Unsubscribe removes a client.
func (sb *StatusBroadcaster) Unsubscribe(id int) {
	sb.mu.Lock()
	removed := false
	if ch, ok := sb.clients[id]; ok {
		close(ch)
		delete(sb.clients, id)
		removed = true
		logger.Debug("StatusBroadcaster", "Client #%d unsubscribed (remaining clients: %d)", id, len(sb.clients))
	}
	sb.mu.Unlock()

	if removed {
		sb.notifyChange()
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
				// No clients — save CPU by sleeping instead of generating status
				time.Sleep(500 * time.Millisecond)
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

// GetClientCount returns the number of connected status SSE clients.
func (sb *StatusBroadcaster) GetClientCount() int {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	return len(sb.clients)
}

func (sb *StatusBroadcaster) notifyChange() {
	if sb.onChange != nil {
		select {
		case sb.onChange <- struct{}{}:
		default:
		}
	}
}

// ConnectionCounts holds the current connection counts for all stream types.
type ConnectionCounts struct {
	WebRTC       int   `json:"webrtc"`
	MJPEG        int   `json:"mjpeg"`
	DetectionSSE int   `json:"detection_sse"`
	StatusSSE    int   `json:"status_sse"`
	Total        int   `json:"total"`
	Timestamp    int64 `json:"timestamp"`
}

// ConnectionBroadcaster manages fanout of connection count events to multiple SSE clients.
// Uses event-driven notifications from other broadcasters instead of polling.
type ConnectionBroadcaster struct {
	mu      sync.Mutex
	clients map[int]chan []byte
	nextID  int
	stop    chan struct{}
	stopped bool

	// Channel to receive change notifications from other broadcasters
	onChange chan struct{}

	// References to other broadcasters for counting
	frameBroadcaster     *FrameBroadcaster
	detectionBroadcaster *DetectionBroadcaster
	statusBroadcaster    *StatusBroadcaster

	// WebRTC client count fetcher (HTTP call to WebRTC server)
	webrtcCountURL string

	// Cache last WebRTC count (fetched on demand)
	lastWebRTCCount int
}

// NewConnectionBroadcaster creates a broadcaster for connection count events.
// Returns the broadcaster and a notification channel that other broadcasters should send to.
func NewConnectionBroadcaster(
	webrtcCountURL string,
) (*ConnectionBroadcaster, chan<- struct{}) {
	onChange := make(chan struct{}, 16) // Buffered to avoid blocking senders
	return &ConnectionBroadcaster{
		clients:        make(map[int]chan []byte),
		stop:           make(chan struct{}),
		onChange:       onChange,
		webrtcCountURL: webrtcCountURL,
	}, onChange
}

// SetBroadcasters sets references to other broadcasters (called after all are created).
func (cb *ConnectionBroadcaster) SetBroadcasters(
	frameBroadcaster *FrameBroadcaster,
	detectionBroadcaster *DetectionBroadcaster,
	statusBroadcaster *StatusBroadcaster,
) {
	cb.frameBroadcaster = frameBroadcaster
	cb.detectionBroadcaster = detectionBroadcaster
	cb.statusBroadcaster = statusBroadcaster
}

// Subscribe adds a new client and returns a channel for receiving connection count events.
func (cb *ConnectionBroadcaster) Subscribe() (int, <-chan []byte) {
	cb.mu.Lock()
	id := cb.nextID
	cb.nextID++
	ch := make(chan []byte, 2)
	cb.clients[id] = ch
	logger.Debug("ConnectionBroadcaster", "Client #%d subscribed (total clients: %d)", id, len(cb.clients))
	cb.mu.Unlock()

	// Trigger immediate update for the new subscriber
	select {
	case cb.onChange <- struct{}{}:
	default:
	}

	return id, ch
}

// Unsubscribe removes a client.
func (cb *ConnectionBroadcaster) Unsubscribe(id int) {
	cb.mu.Lock()
	if ch, ok := cb.clients[id]; ok {
		close(ch)
		delete(cb.clients, id)
		logger.Debug("ConnectionBroadcaster", "Client #%d unsubscribed (remaining clients: %d)", id, len(cb.clients))
	}
	cb.mu.Unlock()
}

// Start begins the connection count event loop.
func (cb *ConnectionBroadcaster) Start() {
	go cb.run()
}

// Stop halts the broadcaster.
func (cb *ConnectionBroadcaster) Stop() {
	cb.mu.Lock()
	if !cb.stopped {
		close(cb.stop)
		cb.stopped = true
	}
	cb.mu.Unlock()
}

// GetClientCount returns the number of connected connection SSE clients.
func (cb *ConnectionBroadcaster) GetClientCount() int {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return len(cb.clients)
}

// GetCounts returns the current connection counts.
func (cb *ConnectionBroadcaster) GetCounts() ConnectionCounts {
	counts := ConnectionCounts{
		MJPEG:        cb.frameBroadcaster.GetClientCount(),
		DetectionSSE: cb.detectionBroadcaster.GetClientCount(),
		StatusSSE:    cb.statusBroadcaster.GetClientCount(),
		WebRTC:       cb.lastWebRTCCount,
		Timestamp:    time.Now().Unix(),
	}
	counts.Total = counts.WebRTC + counts.MJPEG + counts.DetectionSSE + counts.StatusSSE
	return counts
}

func (cb *ConnectionBroadcaster) fetchWebRTCCount() int {
	if cb.webrtcCountURL == "" {
		return 0
	}

	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Get(cb.webrtcCountURL)
	if err != nil {
		logger.Debug("ConnectionBroadcaster", "Failed to fetch WebRTC count: %v", err)
		return cb.lastWebRTCCount // Return cached value on error
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return cb.lastWebRTCCount
	}

	var result struct {
		Count int `json:"count"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return cb.lastWebRTCCount
	}
	cb.lastWebRTCCount = result.Count
	return result.Count
}

func (cb *ConnectionBroadcaster) run() {
	logger.Info("ConnectionBroadcaster", "Starting connection count broadcaster (event-driven)...")

	// Periodic WebRTC count refresh (since WebRTC server is separate)
	webrtcTicker := time.NewTicker(2 * time.Second)
	defer webrtcTicker.Stop()

	for {
		select {
		case <-cb.stop:
			return

		case <-cb.onChange:
			// Drain any additional pending notifications (coalesce rapid changes)
			for len(cb.onChange) > 0 {
				<-cb.onChange
			}
			cb.broadcastCounts()

		case <-webrtcTicker.C:
			// Periodically check WebRTC count (separate server)
			cb.mu.Lock()
			clientCount := len(cb.clients)
			cb.mu.Unlock()

			if clientCount == 0 {
				continue
			}

			oldCount := cb.lastWebRTCCount
			newCount := cb.fetchWebRTCCount()
			if newCount != oldCount {
				cb.broadcastCounts()
			}
		}
	}
}

func (cb *ConnectionBroadcaster) broadcastCounts() {
	cb.mu.Lock()
	clientCount := len(cb.clients)
	cb.mu.Unlock()

	if clientCount == 0 {
		return
	}

	// Refresh WebRTC count before broadcasting (since it's from separate server)
	cb.fetchWebRTCCount()

	counts := cb.GetCounts()
	jsonData, err := json.Marshal(counts)
	if err != nil {
		logger.Error("ConnectionBroadcaster", "JSON marshal error: %v", err)
		return
	}

	cb.mu.Lock()
	for id, ch := range cb.clients {
		select {
		case ch <- jsonData:
		default:
			_ = id
		}
	}
	cb.mu.Unlock()
}

// ── HeatmapBroadcaster ──────────────────────────────────────────────

// HeatmapBroadcaster watches a JSON file for changes and pushes updates to SSE clients.
type HeatmapBroadcaster struct {
	mu       sync.Mutex
	clients  map[int]chan []byte
	nextID   int
	stop     chan struct{}
	stopped  bool
	filePath string
	lastMod  time.Time
}

// NewHeatmapBroadcaster creates a broadcaster that watches filePath for mtime changes.
func NewHeatmapBroadcaster(filePath string) *HeatmapBroadcaster {
	return &HeatmapBroadcaster{
		clients:  make(map[int]chan []byte),
		stop:     make(chan struct{}),
		filePath: filePath,
	}
}

// Subscribe adds a new client and returns a channel for receiving heatmap events.
func (hb *HeatmapBroadcaster) Subscribe() (int, <-chan []byte) {
	hb.mu.Lock()
	id := hb.nextID
	hb.nextID++
	ch := make(chan []byte, 2)
	hb.clients[id] = ch
	logger.Debug("HeatmapBroadcaster", "Client #%d subscribed (total clients: %d)", id, len(hb.clients))
	hb.mu.Unlock()
	return id, ch
}

// Unsubscribe removes a client.
func (hb *HeatmapBroadcaster) Unsubscribe(id int) {
	hb.mu.Lock()
	if ch, ok := hb.clients[id]; ok {
		close(ch)
		delete(hb.clients, id)
		logger.Debug("HeatmapBroadcaster", "Client #%d unsubscribed (remaining clients: %d)", id, len(hb.clients))
	}
	hb.mu.Unlock()
}

// Start begins the file-watching event loop.
func (hb *HeatmapBroadcaster) Start() {
	go hb.run()
}

// Stop halts the broadcaster.
func (hb *HeatmapBroadcaster) Stop() {
	hb.mu.Lock()
	if !hb.stopped {
		close(hb.stop)
		hb.stopped = true
	}
	hb.mu.Unlock()
}

// GetClientCount returns the number of connected heatmap SSE clients.
func (hb *HeatmapBroadcaster) GetClientCount() int {
	hb.mu.Lock()
	defer hb.mu.Unlock()
	return len(hb.clients)
}

func (hb *HeatmapBroadcaster) run() {
	logger.Info("HeatmapBroadcaster", "Starting heatmap broadcaster (file=%s, interval=100ms)", hb.filePath)
	ticker := time.NewTicker(100 * time.Millisecond) // ~10fps
	defer ticker.Stop()

	for {
		select {
		case <-hb.stop:
			return
		case <-ticker.C:
		}

		hb.mu.Lock()
		clientCount := len(hb.clients)
		hb.mu.Unlock()

		if clientCount == 0 {
			continue
		}

		info, err := os.Stat(hb.filePath)
		if err != nil || !info.ModTime().After(hb.lastMod) {
			continue
		}
		hb.lastMod = info.ModTime()

		data, err := os.ReadFile(hb.filePath)
		if err != nil {
			continue
		}

		hb.broadcast(data)
	}
}

func (hb *HeatmapBroadcaster) broadcast(data []byte) {
	hb.mu.Lock()
	for _, ch := range hb.clients {
		select {
		case ch <- data:
		default:
			// Drop if client is slow
		}
	}
	hb.mu.Unlock()
}
