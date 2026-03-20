package webmonitor

import (
	"path/filepath"
	"time"
)

// Config defines the runtime configuration for the web monitor server.
type Config struct {
	Addr                string
	AssetsDir           string
	BuildAssetsDir      string
	FrameShmName        string        // NV12 frame SHM for MJPEG streaming
	H264ShmName         string        // H.264 stream SHM for recording
	DetectionShmName    string
	WebRTCBaseURL       string
	TargetFPS           int
	StatusInterval      time.Duration
	DetectionInterval   time.Duration
	MJPEGInterval       time.Duration
	RecordingOutputPath string
	TLSCertFile         string
	TLSKeyFile          string
	JPEGQuality         int // JPEG encoding quality (1-100, default 85)
}

// DefaultConfig returns a config aligned with the existing Flask monitor behavior.
func DefaultConfig() Config {
	return Config{
		Addr:                ":8080",
		AssetsDir:           filepath.Clean("../web"),
		BuildAssetsDir:      filepath.Clean("../../build/web"),
		FrameShmName:        "/pet_camera_mjpeg_frame",
		H264ShmName:         "/pet_camera_stream",
		DetectionShmName:    "/pet_camera_detections",
		WebRTCBaseURL:       "http://localhost:8081",
		TargetFPS:           30,
		StatusInterval:      2 * time.Second,
		DetectionInterval:   33 * time.Millisecond,
		MJPEGInterval:       33 * time.Millisecond,
		RecordingOutputPath: "./recordings",
		JPEGQuality:         65,
	}
}
