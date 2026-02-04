package webmonitor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/h264"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/shm"
)

const (
	// HeartbeatTimeout is the maximum time without heartbeat before auto-stop
	HeartbeatTimeout = 3 * time.Second
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
	shmReader            *shm.Reader
	h264Processor        *h264.Processor
	recording            bool
	converting           bool // true while MP4 conversion is in progress
	file                 *os.File
	filename             string
	startTime            time.Time
	frameCount           uint64
	bytesWritten         uint64
	lastHeartbeat        time.Time
	stopReason           string
	firstDetectionOffset float64 // seconds from recording start when first detection occurred (-1 = none)

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

	if r.converting {
		return "", fmt.Errorf("conversion in progress")
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
	r.firstDetectionOffset = -1 // -1 means no detection yet
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
	detectionOffset := r.firstDetectionOffset

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

	logger.Info("H264Recorder", "Stopped recording: %s (frames=%d, bytes=%d, firstDetection=%.2fs)",
		filename, r.frameCount, r.bytesWritten, detectionOffset)

	// Start MP4 conversion in background
	r.converting = true
	go r.convertToMP4(filename, detectionOffset)

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
// detectionOffset is the timestamp (in seconds) of first detection, or -1 if none
func (r *H264Recorder) convertToMP4(h264Filename string, detectionOffset float64) {
	// Ensure converting flag is cleared when done
	defer func() {
		r.mu.Lock()
		r.converting = false
		r.mu.Unlock()
		logger.Info("H264Recorder", "Post-processing complete, ready for new recording")
	}()

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

	// Generate thumbnail at first detection time, or fallback to default
	r.generateThumbnail(mp4Path, detectionOffset)

	// Delete H.264 file after successful conversion
	if err := os.Remove(h264Path); err != nil {
		logger.Warn("H264Recorder", "Failed to delete H.264 file: %v", err)
	} else {
		logger.Info("H264Recorder", "Deleted H.264 file: %s", h264Filename)
	}
}

// generateThumbnail generates a JPG thumbnail from the MP4 file
// detectionOffset is the preferred timestamp (in seconds), or -1 to use default fallback
func (r *H264Recorder) generateThumbnail(mp4Path string, detectionOffset float64) {
	thumbPath := mp4Path[:len(mp4Path)-4] + ".jpg"
	logger.Info("H264Recorder", "Generating thumbnail: %s (detectionOffset=%.2f)", filepath.Base(thumbPath), detectionOffset)

	// Build seek times to try: detection offset (if valid), then 3s, then 0s
	var seekTimes []string
	if detectionOffset >= 0 {
		seekTimes = append(seekTimes, fmt.Sprintf("%.2f", detectionOffset))
	}
	seekTimes = append(seekTimes, "3", "0")

	for i, seekTime := range seekTimes {
		cmd := exec.Command("nice", "-n", "19",
			"ffmpeg", "-y",
			"-ss", seekTime,
			"-i", mp4Path,
			"-vframes", "1",
			"-vf", "scale=160:-1",
			"-q:v", "2",
			thumbPath,
		)

		output, err := cmd.CombinedOutput()
		if err != nil {
			if i < len(seekTimes)-1 {
				// Retry with next fallback
				logger.Debug("H264Recorder", "Thumbnail at %ss failed, trying next: %s", seekTime, filepath.Base(mp4Path))
				continue
			}
			logger.Warn("H264Recorder", "Thumbnail generation failed: %v\n%s", err, string(output))
			return
		}

		// Check if file was actually created and has content
		if info, err := os.Stat(thumbPath); err == nil && info.Size() > 0 {
			logger.Info("H264Recorder", "Thumbnail generated (at %ss): %s", seekTime, filepath.Base(thumbPath))
			return
		}

		if i < len(seekTimes)-1 {
			// Empty file, retry with next fallback
			logger.Debug("H264Recorder", "Thumbnail at %ss empty, trying next: %s", seekTime, filepath.Base(mp4Path))
			continue
		}
	}

	logger.Warn("H264Recorder", "Thumbnail generation failed for: %s", filepath.Base(mp4Path))
}

// RegenerateThumbnail regenerates thumbnail at specified timestamp
func (r *H264Recorder) RegenerateThumbnail(filename string, timestamp float64) error {
	// Validate filename
	mp4Path, err := r.GetRecordingPath(filename)
	if err != nil {
		return err
	}
	if !strings.HasSuffix(filename, ".mp4") {
		return fmt.Errorf("only mp4 files supported")
	}

	thumbPath := mp4Path[:len(mp4Path)-4] + ".jpg"

	cmd := exec.Command("nice", "-n", "19",
		"ffmpeg", "-y",
		"-ss", fmt.Sprintf("%.2f", timestamp),
		"-i", mp4Path,
		"-vframes", "1",
		"-vf", "scale=160:-1",
		"-q:v", "2",
		thumbPath,
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("thumbnail generation failed: %v\n%s", err, string(output))
	}

	logger.Info("H264Recorder", "Thumbnail regenerated at %.2fs: %s", timestamp, filepath.Base(thumbPath))
	return nil
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
	detectionOffset := r.firstDetectionOffset
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
	r.mu.Lock()
	r.converting = true
	r.mu.Unlock()
	go r.convertToMP4(filename, detectionOffset)
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

// NotifyDetection records the first detection time during recording
// Returns true if this was the first detection, false if already recorded or not recording
func (r *H264Recorder) NotifyDetection() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.recording {
		return false
	}

	// Only record the first detection
	if r.firstDetectionOffset >= 0 {
		return false
	}

	r.firstDetectionOffset = time.Since(r.startTime).Seconds()
	logger.Info("H264Recorder", "First detection at %.2fs into recording", r.firstDetectionOffset)
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
		"converting":    r.converting,
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

	// First pass: collect thumbnail files
	thumbnails := make(map[string]bool)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasSuffix(name, ".jpg") {
			thumbnails[name] = true
		}
	}

	var recordings []RecordingInfo
	var missingThumbnails []string

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

		rec := RecordingInfo{
			Name:      name,
			SizeBytes: info.Size(),
			CreatedAt: info.ModTime(),
		}

		// Check for corresponding thumbnail
		thumbName := name[:len(name)-len(ext)] + ".jpg"
		if thumbnails[thumbName] {
			rec.Thumbnail = thumbName
		} else if ext == ".mp4" {
			// MP4 without thumbnail - queue for generation
			missingThumbnails = append(missingThumbnails, name)
		}

		recordings = append(recordings, rec)
	}

	// Generate missing thumbnails in background
	if len(missingThumbnails) > 0 {
		go r.generateMissingThumbnails(missingThumbnails)
	}

	return recordings, nil
}

// generateMissingThumbnails generates thumbnails for MP4 files that don't have them
func (r *H264Recorder) generateMissingThumbnails(filenames []string) {
	for _, filename := range filenames {
		mp4Path := filepath.Join(r.outputPath, filename)
		thumbPath := mp4Path[:len(mp4Path)-4] + ".jpg"

		// Double-check thumbnail doesn't exist (avoid race condition)
		if _, err := os.Stat(thumbPath); err == nil {
			continue
		}

		logger.Info("H264Recorder", "Generating missing thumbnail for: %s", filename)
		r.generateThumbnail(mp4Path, -1) // -1 = no detection data for existing recordings
	}
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

// DeleteRecording deletes a recording file and its corresponding thumbnail
func (r *H264Recorder) DeleteRecording(filename string) error {
	path, err := r.GetRecordingPath(filename)
	if err != nil {
		return err
	}

	// Delete the recording file
	if err := os.Remove(path); err != nil {
		return err
	}

	// Also delete corresponding thumbnail if it exists
	ext := filepath.Ext(filename)
	if ext == ".mp4" || ext == ".h264" {
		thumbPath := path[:len(path)-len(ext)] + ".jpg"
		if _, err := os.Stat(thumbPath); err == nil {
			if err := os.Remove(thumbPath); err != nil {
				logger.Warn("H264Recorder", "Failed to delete thumbnail: %v", err)
			} else {
				logger.Info("H264Recorder", "Deleted thumbnail: %s", filepath.Base(thumbPath))
			}
		}
	}

	return nil
}

// RecordingInfo holds metadata about a recording
type RecordingInfo struct {
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
	Thumbnail string    `json:"thumbnail,omitempty"`
}
