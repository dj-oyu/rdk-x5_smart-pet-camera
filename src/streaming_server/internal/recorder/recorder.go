package recorder

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/types"
)

// Recorder records H.264 frames to file
type Recorder struct {
	mu            sync.RWMutex
	file          *os.File
	filename      string
	basePath      string
	recording     bool
	frameCount    uint64
	bytesWritten  uint64
	startTime     time.Time
	frameChan     chan *types.H264Frame
	closeChan     chan struct{}
	wg            sync.WaitGroup

	// Header management
	spsCache      []byte
	ppsCache      []byte
	firstIDRWritten bool
}

// NewRecorder creates a new recorder
func NewRecorder(basePath string) *Recorder {
	return &Recorder{
		basePath:  basePath,
		recording: false,
		frameChan: make(chan *types.H264Frame, 60), // Buffer 2 seconds
		closeChan: make(chan struct{}),
	}
}

// Start starts recording to a new file
func (r *Recorder) Start() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.recording {
		return fmt.Errorf("already recording")
	}

	// Generate filename with timestamp
	timestamp := time.Now().Format("20060102_150405")
	filename := fmt.Sprintf("recording_%s.h264", timestamp)
	filepath := filepath.Join(r.basePath, filename)

	// Create file
	file, err := os.Create(filepath)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}

	// Initialize state
	r.file = file
	r.filename = filename
	r.recording = true
	r.frameCount = 0
	r.bytesWritten = 0
	r.startTime = time.Now()
	r.firstIDRWritten = false

	// Start recorder goroutine
	r.wg.Add(1)
	go r.writeFrames()

	return nil
}

// Stop stops recording
func (r *Recorder) Stop() error {
	r.mu.Lock()

	if !r.recording {
		r.mu.Unlock()
		return fmt.Errorf("not recording")
	}

	r.recording = false
	r.mu.Unlock()

	// Wait for write goroutine to finish
	r.wg.Wait()

	// Close file
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.file != nil {
		if err := r.file.Sync(); err != nil {
			return fmt.Errorf("failed to sync file: %w", err)
		}
		if err := r.file.Close(); err != nil {
			return fmt.Errorf("failed to close file: %w", err)
		}
		r.file = nil
	}

	return nil
}

// UpdateHeaders updates the cached SPS/PPS headers
func (r *Recorder) UpdateHeaders(sps, pps []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(sps) > 0 {
		r.spsCache = make([]byte, len(sps))
		copy(r.spsCache, sps)
	}
	if len(pps) > 0 {
		r.ppsCache = make([]byte, len(pps))
		copy(r.ppsCache, pps)
	}
}

// SendFrame sends a frame to the recorder (non-blocking)
func (r *Recorder) SendFrame(frame *types.H264Frame) bool {
	r.mu.RLock()
	recording := r.recording
	r.mu.RUnlock()

	if !recording {
		return false
	}

	// Non-blocking send
	select {
	case r.frameChan <- frame:
		return true
	default:
		// Channel full, drop frame
		return false
	}
}

// writeFrames writes frames to file
func (r *Recorder) writeFrames() {
	defer r.wg.Done()

	for {
		r.mu.RLock()
		recording := r.recording
		r.mu.RUnlock()

		if !recording {
			// Drain remaining frames
			for len(r.frameChan) > 0 {
				frame := <-r.frameChan
				r.writeFrame(frame)
			}
			return
		}

		select {
		case frame := <-r.frameChan:
			r.writeFrame(frame)
		case <-time.After(100 * time.Millisecond):
			// Check recording state periodically
		}
	}
}

// writeFrame writes a single frame to file
func (r *Recorder) writeFrame(frame *types.H264Frame) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.file == nil {
		return
	}

	var dataToWrite []byte

	// If this is the first IDR frame and we have cached headers, prepend them
	if frame.IsIDR && !r.firstIDRWritten && len(r.spsCache) > 0 && len(r.ppsCache) > 0 {
		// Prepend SPS and PPS headers to ensure playability
		dataToWrite = make([]byte, 0, len(r.spsCache)+len(r.ppsCache)+len(frame.Data))
		dataToWrite = append(dataToWrite, r.spsCache...)
		dataToWrite = append(dataToWrite, r.ppsCache...)
		dataToWrite = append(dataToWrite, frame.Data...)
		r.firstIDRWritten = true
	} else {
		// Write frame as-is
		dataToWrite = frame.Data
	}

	n, err := r.file.Write(dataToWrite)
	if err != nil {
		// Log error but continue
		return
	}

	r.bytesWritten += uint64(n)
	r.frameCount++
}

// IsRecording returns true if currently recording
func (r *Recorder) IsRecording() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.recording
}

// GetStatus returns the current recording status
func (r *Recorder) GetStatus() RecordingStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var duration time.Duration
	if r.recording {
		duration = time.Since(r.startTime)
	}

	return RecordingStatus{
		Recording:    r.recording,
		Filename:     r.filename,
		FrameCount:   r.frameCount,
		BytesWritten: r.bytesWritten,
		Duration:     duration,
		StartTime:    r.startTime,
	}
}

// Close closes the recorder
func (r *Recorder) Close() error {
	if r.IsRecording() {
		return r.Stop()
	}
	close(r.closeChan)
	return nil
}

// RecordingStatus holds the current recording status
type RecordingStatus struct {
	Recording    bool          `json:"recording"`
	Filename     string        `json:"filename"`
	FrameCount   uint64        `json:"frame_count"`
	BytesWritten uint64        `json:"bytes_written"`
	Duration     time.Duration `json:"duration_ms"`
	StartTime    time.Time     `json:"start_time"`
}
