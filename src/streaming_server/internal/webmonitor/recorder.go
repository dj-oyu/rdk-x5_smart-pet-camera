package webmonitor

import (
	"fmt"
	"path/filepath"
	"sync"
	"time"
)

// RecorderState emulates the Flask recorder API shape.
type RecorderState struct {
	mu           sync.Mutex
	recording    bool
	filepath     string
	frameCount   int
	bytesWritten int
}

// NewRecorderState creates a recorder state with the given output path.
func NewRecorderState(outputPath string) *RecorderState {
	return &RecorderState{
		filepath: outputPath,
	}
}

// Start begins recording and returns the output filename.
func (r *RecorderState) Start(filename string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.recording {
		return "", fmt.Errorf("Already recording")
	}

	if filename == "" {
		timestamp := time.Now().Format("20060102_150405")
		filename = fmt.Sprintf("recording_%s.h264", timestamp)
	}

	r.filepath = filepath.Join("./recordings", filename)
	r.recording = true
	r.frameCount = 0
	r.bytesWritten = 0

	return r.filepath, nil
}

// Stop ends recording and returns the output filename.
func (r *RecorderState) Stop() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.recording {
		return "", fmt.Errorf("Not recording")
	}

	r.recording = false
	return r.filepath, nil
}

// Status returns the recorder status payload.
func (r *RecorderState) Status() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()

	var filename any
	if r.filepath != "" {
		filename = r.filepath
	} else {
		filename = nil
	}

	return map[string]any{
		"recording":     r.recording,
		"frame_count":   r.frameCount,
		"bytes_written": r.bytesWritten,
		"filename":      filename,
	}
}
