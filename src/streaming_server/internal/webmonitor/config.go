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
	FrameShmName        string
	DetectionShmName    string
	WebRTCBaseURL       string
	TargetFPS           int
	StatusInterval      time.Duration
	DetectionInterval   time.Duration
	MJPEGInterval       time.Duration
	RecordingOutputPath string
}

// DefaultConfig returns a config aligned with the existing Flask monitor behavior.
func DefaultConfig() Config {
	return Config{
		Addr:                ":8080",
		AssetsDir:           filepath.Clean("../monitor/web_assets"),
		BuildAssetsDir:      filepath.Clean("../../build/web"),
		FrameShmName:        "/pet_camera_mjpeg_frame",
		DetectionShmName:    "/pet_camera_detections",
		WebRTCBaseURL:       "http://localhost:8081",
		TargetFPS:           30,
		StatusInterval:      2 * time.Second,
		DetectionInterval:   33 * time.Millisecond,
		MJPEGInterval:       33 * time.Millisecond,
		RecordingOutputPath: "./recordings",
	}
}
