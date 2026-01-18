package main

import (
	"flag"
	"log"
	"net/http"
	"os"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/webmonitor"
)

func main() {
	cfg := webmonitor.DefaultConfig()

	var logLevel string
	var logColor bool

	flag.StringVar(&cfg.Addr, "http", cfg.Addr, "HTTP server address")
	flag.StringVar(&cfg.AssetsDir, "assets", cfg.AssetsDir, "Web assets directory")
	flag.StringVar(&cfg.BuildAssetsDir, "assets-build", cfg.BuildAssetsDir, "Build assets directory")
	flag.StringVar(&cfg.FrameShmName, "frame-shm", cfg.FrameShmName, "Frame shared memory name")
	flag.StringVar(&cfg.DetectionShmName, "detection-shm", cfg.DetectionShmName, "Detection shared memory name")
	flag.StringVar(&cfg.WebRTCBaseURL, "webrtc-base", cfg.WebRTCBaseURL, "WebRTC Go server base URL")
	flag.IntVar(&cfg.TargetFPS, "fps", cfg.TargetFPS, "Target FPS for stats")
	flag.StringVar(&logLevel, "log-level", "info", "Log level (debug, info, warn, error, silent)")
	flag.BoolVar(&logColor, "log-color", true, "Enable colored log output")
	flag.Parse()

	// Initialize logger
	level, err := logger.ParseLevel(logLevel)
	if err != nil {
		log.Fatalf("Invalid log level: %v", err)
	}
	logger.Init(level, os.Stderr, logColor)

	server := webmonitor.NewServer(cfg)

	logger.Info("Main", "Go web monitor listening on %s", cfg.Addr)
	logger.Info("Main", "Assets: %s (build: %s)", cfg.AssetsDir, cfg.BuildAssetsDir)
	logger.Info("Main", "Log level: %s", level)

	httpServer := &http.Server{
		Addr:    cfg.Addr,
		Handler: server.Handler(),
	}

	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}
