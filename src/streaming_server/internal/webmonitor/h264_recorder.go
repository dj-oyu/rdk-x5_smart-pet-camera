package webmonitor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/h264"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/shm"
)

const (
	// HeartbeatTimeout is the maximum time without heartbeat before auto-stop
	HeartbeatTimeout = 60 * time.Second
	// MaxRecordingDuration is the maximum recording duration
	MaxRecordingDuration = 30 * time.Minute
)

// H264Recorder manages H.264 recording from shared memory
type H264Recorder struct {
	mu sync.RWMutex

	// Configuration
	outputPath string
	shmName    string

	// Runtime state
	shmReader     *shm.Reader
	h264Processor *h264.Processor
	recording     bool
	file          *os.File
	filename      string
	startTime     time.Time
	frameCount    uint64
	bytesWritten  uint64
	lastHeartbeat time.Time
	stopReason    string

	// Control
	stopCh chan struct{}
	wg     sync.WaitGroup
}

// NewH264Recorder creates a new H.264 recorder
func NewH264Recorder(outputPath, shmName string) *H264Recorder {
	return &H264Recorder{
		outputPath: outputPath,
		shmName:    shmName,
	}
}

// Start begins recording H.264 frames to a new file
func (r *H264Recorder) Start() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.recording {
		return "", fmt.Errorf("already recording")
	}

	// Ensure output directory exists
	if err := os.MkdirAll(r.outputPath, 0755); err != nil {
		return "", fmt.Errorf("failed to create output directory: %w", err)
	}

	// Generate filename with timestamp
	timestamp := time.Now().Format("20060102_150405")
	r.filename = fmt.Sprintf("recording_%s.h264", timestamp)
	filepath := filepath.Join(r.outputPath, r.filename)

	// Create file
	file, err := os.Create(filepath)
	if err != nil {
		return "", fmt.Errorf("failed to create file: %w", err)
	}

	// Open SHM reader
	reader, err := shm.NewReader(r.shmName)
	if err != nil {
		file.Close()
		os.Remove(filepath)
		return "", fmt.Errorf("failed to open shared memory: %w", err)
	}

	// Initialize state
	r.shmReader = reader
	r.h264Processor = h264.NewProcessor()
	r.file = file
	r.recording = true
	r.startTime = time.Now()
	r.frameCount = 0
	r.bytesWritten = 0
	r.lastHeartbeat = time.Now()
	r.stopReason = ""
	r.stopCh = make(chan struct{})

	// Start recording goroutine
	r.wg.Add(1)
	go r.recordLoop()

	logger.Info("H264Recorder", "Started recording to %s", filepath)
	return r.filename, nil
}

// Stop stops recording and returns the filename
func (r *H264Recorder) Stop() (string, error) {
	r.mu.Lock()

	if !r.recording {
		r.mu.Unlock()
		return "", fmt.Errorf("not recording")
	}

	// Signal stop
	close(r.stopCh)
	r.recording = false
	filename := r.filename

	r.mu.Unlock()

	// Wait for recording goroutine to finish
	r.wg.Wait()

	r.mu.Lock()
	defer r.mu.Unlock()

	// Close file
	if r.file != nil {
		if err := r.file.Sync(); err != nil {
			logger.Warn("H264Recorder", "Failed to sync file: %v", err)
		}
		if err := r.file.Close(); err != nil {
			logger.Warn("H264Recorder", "Failed to close file: %v", err)
		}
		r.file = nil
	}

	// Close SHM reader
	if r.shmReader != nil {
		r.shmReader.Close()
		r.shmReader = nil
	}

	logger.Info("H264Recorder", "Stopped recording: %s (frames=%d, bytes=%d)",
		filename, r.frameCount, r.bytesWritten)

	// Start MP4 conversion in background
	go r.convertToMP4(filename)

	return filename, nil
}

// recordLoop reads frames from SHM and writes to file
func (r *H264Recorder) recordLoop() {
	defer r.wg.Done()

	ticker := time.NewTicker(33 * time.Millisecond) // ~30fps
	defer ticker.Stop()

	firstIDRWritten := false
	var lastFrameNum uint64

	for {
		select {
		case <-r.stopCh:
			return
		case <-ticker.C:
			r.mu.RLock()
			if !r.recording || r.shmReader == nil {
				r.mu.RUnlock()
				return
			}

			// Check for heartbeat timeout
			if time.Since(r.lastHeartbeat) > HeartbeatTimeout {
				r.mu.RUnlock()
				logger.Warn("H264Recorder", "Heartbeat timeout, auto-stopping recording")
				r.autoStop("heartbeat timeout")
				return
			}

			// Check for max duration
			if time.Since(r.startTime) > MaxRecordingDuration {
				r.mu.RUnlock()
				logger.Warn("H264Recorder", "Max duration reached, auto-stopping recording")
				r.autoStop("max duration reached")
				return
			}

			reader := r.shmReader
			processor := r.h264Processor
			r.mu.RUnlock()

			// Read frame from SHM
			frame, err := reader.ReadLatest()
			if err != nil {
				logger.Debug("H264Recorder", "Read error: %v", err)
				continue
			}
			if frame == nil {
				continue
			}

			// Skip duplicate frames
			if frame.FrameNum == lastFrameNum {
				continue
			}
			lastFrameNum = frame.FrameNum

			// Process frame to detect IDR and cache SPS/PPS
			if err := processor.Process(frame); err != nil {
				logger.Debug("H264Recorder", "Process error: %v", err)
			}

			// Write frame to file
			r.mu.Lock()
			if r.file == nil || !r.recording {
				r.mu.Unlock()
				return
			}

			var dataToWrite []byte

			// If this is the first IDR frame, prepend SPS/PPS
			if frame.IsIDR && !firstIDRWritten {
				headers, _ := processor.PrependHeaders(frame.Data)
				if len(headers) > len(frame.Data) {
					dataToWrite = headers
					firstIDRWritten = true
				} else {
					dataToWrite = frame.Data
				}
			} else {
				dataToWrite = frame.Data
			}

			n, err := r.file.Write(dataToWrite)
			if err != nil {
				logger.Warn("H264Recorder", "Write error: %v", err)
				r.mu.Unlock()
				continue
			}

			r.frameCount++
			r.bytesWritten += uint64(n)
			r.mu.Unlock()
		}
	}
}

// convertToMP4 converts H.264 file to MP4 using ffmpeg (background task)
func (r *H264Recorder) convertToMP4(h264Filename string) {
	h264Path := filepath.Join(r.outputPath, h264Filename)
	mp4Filename := h264Filename[:len(h264Filename)-5] + ".mp4" // Replace .h264 with .mp4
	mp4Path := filepath.Join(r.outputPath, mp4Filename)

	logger.Info("H264Recorder", "Starting MP4 conversion: %s -> %s", h264Filename, mp4Filename)

	// Run ffmpeg with low priority (nice -n 19)
	cmd := exec.Command("nice", "-n", "19",
		"ffmpeg", "-y",
		"-f", "h264",
		"-i", h264Path,
		"-c", "copy",
		mp4Path,
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		logger.Warn("H264Recorder", "MP4 conversion failed: %v\n%s", err, string(output))
		return
	}

	logger.Info("H264Recorder", "MP4 conversion complete: %s", mp4Filename)

	// Delete H.264 file after successful conversion
	if err := os.Remove(h264Path); err != nil {
		logger.Warn("H264Recorder", "Failed to delete H.264 file: %v", err)
	} else {
		logger.Info("H264Recorder", "Deleted H.264 file: %s", h264Filename)
	}
}

// autoStop stops recording due to timeout (called from recordLoop)
func (r *H264Recorder) autoStop(reason string) {
	r.mu.Lock()
	if !r.recording {
		r.mu.Unlock()
		return
	}
	r.stopReason = reason
	r.recording = false
	filename := r.filename
	r.mu.Unlock()

	// Close file
	r.mu.Lock()
	if r.file != nil {
		r.file.Sync()
		r.file.Close()
		r.file = nil
	}
	if r.shmReader != nil {
		r.shmReader.Close()
		r.shmReader = nil
	}
	r.mu.Unlock()

	logger.Info("H264Recorder", "Auto-stopped recording: %s (reason=%s)", filename, reason)

	// Start MP4 conversion in background
	go r.convertToMP4(filename)
}

// Heartbeat updates the last heartbeat time to prevent auto-stop
func (r *H264Recorder) Heartbeat() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.recording {
		return false
	}

	r.lastHeartbeat = time.Now()
	return true
}

// IsRecording returns true if currently recording
func (r *H264Recorder) IsRecording() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.recording
}

// Status returns the current recording status
func (r *H264Recorder) Status() map[string]any {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var duration time.Duration
	if r.recording {
		duration = time.Since(r.startTime)
	}

	var filename any
	if r.filename != "" {
		filename = r.filename
	}

	return map[string]any{
		"recording":     r.recording,
		"filename":      filename,
		"frame_count":   r.frameCount,
		"bytes_written": r.bytesWritten,
		"duration_ms":   duration.Milliseconds(),
		"stop_reason":   r.stopReason,
	}
}

// ListRecordings returns a list of recording files
func (r *H264Recorder) ListRecordings() ([]RecordingInfo, error) {
	entries, err := os.ReadDir(r.outputPath)
	if err != nil {
		if os.IsNotExist(err) {
			return []RecordingInfo{}, nil
		}
		return nil, err
	}

	var recordings []RecordingInfo
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		name := entry.Name()
		ext := filepath.Ext(name)
		if ext != ".mp4" && ext != ".h264" {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		recordings = append(recordings, RecordingInfo{
			Name:      name,
			SizeBytes: info.Size(),
			CreatedAt: info.ModTime(),
		})
	}

	return recordings, nil
}

// GetRecordingPath returns the full path to a recording file
func (r *H264Recorder) GetRecordingPath(filename string) (string, error) {
	// Sanitize filename to prevent directory traversal
	cleanName := filepath.Base(filename)
	if cleanName != filename {
		return "", fmt.Errorf("invalid filename")
	}

	fullPath := filepath.Join(r.outputPath, cleanName)

	// Check if file exists
	if _, err := os.Stat(fullPath); err != nil {
		return "", fmt.Errorf("recording not found: %s", filename)
	}

	return fullPath, nil
}

// DeleteRecording deletes a recording file
func (r *H264Recorder) DeleteRecording(filename string) error {
	path, err := r.GetRecordingPath(filename)
	if err != nil {
		return err
	}

	return os.Remove(path)
}

// RecordingInfo holds metadata about a recording
type RecordingInfo struct {
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}
