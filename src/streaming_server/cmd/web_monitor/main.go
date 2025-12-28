package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/webmonitor"
)

func main() {
	cfg := webmonitor.DefaultConfig()

	flag.StringVar(&cfg.Addr, "http", cfg.Addr, "HTTP server address")
	flag.StringVar(&cfg.AssetsDir, "assets", cfg.AssetsDir, "Web assets directory")
	flag.StringVar(&cfg.BuildAssetsDir, "assets-build", cfg.BuildAssetsDir, "Build assets directory")
	flag.StringVar(&cfg.FrameShmName, "frame-shm", cfg.FrameShmName, "Frame shared memory name")
	flag.StringVar(&cfg.DetectionShmName, "detection-shm", cfg.DetectionShmName, "Detection shared memory name")
	flag.StringVar(&cfg.WebRTCBaseURL, "webrtc-base", cfg.WebRTCBaseURL, "WebRTC Go server base URL")
	flag.IntVar(&cfg.TargetFPS, "fps", cfg.TargetFPS, "Target FPS for stats")
	flag.Parse()

	server := webmonitor.NewServer(cfg)

	log.Printf("Go web monitor listening on %s", cfg.Addr)
	log.Printf("Assets: %s (build: %s)", cfg.AssetsDir, cfg.BuildAssetsDir)

	httpServer := &http.Server{
		Addr:    cfg.Addr,
		Handler: server.Handler(),
	}

	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}
