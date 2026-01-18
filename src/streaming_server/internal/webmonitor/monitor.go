package webmonitor

import (
	"sync"
	"time"
)

// Monitor synthesizes monitor statistics compatible with the Flask monitor API.
// It can be replaced by a shared-memory backed implementation later.
type Monitor struct {
	startTime time.Time
	targetFPS int

	mu                sync.Mutex
	frameCounter      int
	detectionVersion  int
	detectionHistory  []DetectionResult
	latestDetection   *DetectionResult
	lastDetectionSent int
	shm               *shmReader
}

// NewMonitor creates a Monitor with the given target FPS and shared memory reader.
func NewMonitor(targetFPS int, shm *shmReader) *Monitor {
	return &Monitor{
		startTime:    time.Now(),
		targetFPS:    targetFPS,
		frameCounter: 0,
		shm:          shm,
	}
}

// Snapshot returns the current monitor and shared memory stats.
func (m *Monitor) Snapshot() (MonitorStats, SharedMemoryStats, *DetectionResult, []DetectionResult) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.refreshFromSharedMemoryLocked()

	framesProcessed := m.frameCounter
	monitorStats := MonitorStats{
		FramesProcessed: framesProcessed,
		CurrentFPS:      float64(m.targetFPS),
		DetectionCount:  0,
		TargetFPS:       m.targetFPS,
	}

	if m.latestDetection != nil {
		monitorStats.DetectionCount = m.latestDetection.NumDetections
	}

	shmStats := SharedMemoryStats{
		FrameCount:         minInt(framesProcessed, m.targetFPS),
		TotalFramesWritten: framesProcessed,
		DetectionVersion:   int(m.detectionVersion),
		HasDetection:       boolToInt(m.latestDetection != nil),
	}

	historyCopy := make([]DetectionResult, len(m.detectionHistory))
	copy(historyCopy, m.detectionHistory)

	return monitorStats, shmStats, m.latestDetection, historyCopy
}

// NextDetectionEvent returns a detection event for SSE.
func (m *Monitor) NextDetectionEvent() DetectionEvent {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.refreshFromSharedMemoryLocked()

	m.frameCounter++
	now := time.Now().Unix()
	event := DetectionEvent{
		FrameNumber: m.frameCounter,
		Timestamp:   float64(now),
		Detections:  []Detection{},
	}

	if m.latestDetection != nil && m.lastDetectionSent != m.latestDetection.Version {
		event.FrameNumber = m.latestDetection.FrameNumber
		event.Timestamp = m.latestDetection.Timestamp
		event.Detections = m.latestDetection.Detections
		m.lastDetectionSent = m.latestDetection.Version
	}

	return event
}

// UpdateDetection stores a new detection result.
func (m *Monitor) UpdateDetection(result DetectionResult) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.detectionVersion++
	result.Version = m.detectionVersion
	result.NumDetections = len(result.Detections)
	m.latestDetection = &result
	if result.NumDetections > 0 {
		m.detectionHistory = append([]DetectionResult{result}, m.detectionHistory...)
		if len(m.detectionHistory) > 8 {
			m.detectionHistory = m.detectionHistory[:8]
		}
	}
}

func (m *Monitor) refreshFromSharedMemoryLocked() {
	if m.shm == nil {
		m.updateSyntheticStatsLocked()
		return
	}

	if stats, ok := m.shm.Stats(); ok {
		m.frameCounter = stats.TotalFramesWritten
		m.detectionVersion = stats.DetectionVersion
	}

	if detection, ok := m.shm.LatestDetection(); ok && detection != nil {
		m.latestDetection = detection
		m.detectionVersion = detection.Version
		if detection.NumDetections > 0 {
			m.detectionHistory = append([]DetectionResult{*detection}, m.detectionHistory...)
			if len(m.detectionHistory) > 8 {
				m.detectionHistory = m.detectionHistory[:8]
			}
		}
	}
}

func (m *Monitor) updateSyntheticStatsLocked() {
	elapsed := time.Since(m.startTime).Seconds()
	framesProcessed := int(elapsed * float64(m.targetFPS))
	if framesProcessed > m.frameCounter {
		m.frameCounter = framesProcessed
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

