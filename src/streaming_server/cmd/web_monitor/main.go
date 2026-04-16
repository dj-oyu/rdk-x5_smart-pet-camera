package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/webmonitor"
)

func main() {
	cfg := webmonitor.DefaultConfig()

	var logLevel string
	var logColor bool
	var httpOnlyAddr string

	flag.StringVar(&cfg.Addr, "http", cfg.Addr, "HTTP server address")
	flag.StringVar(&httpOnlyAddr, "http-only", "", "HTTP-only server address for MJPEG stream (e.g., :8082)")
	flag.StringVar(&cfg.AssetsDir, "assets", cfg.AssetsDir, "Web assets directory")
	flag.StringVar(&cfg.BuildAssetsDir, "assets-build", cfg.BuildAssetsDir, "Build assets directory")
	flag.StringVar(&cfg.FrameShmName, "frame-shm", cfg.FrameShmName, "Frame shared memory name")
	flag.StringVar(&cfg.DetectionShmName, "detection-shm", cfg.DetectionShmName, "Detection shared memory name")
	flag.StringVar(&cfg.WebRTCBaseURL, "webrtc-base", cfg.WebRTCBaseURL, "WebRTC Go server base URL")
	flag.IntVar(&cfg.TargetFPS, "fps", cfg.TargetFPS, "Target FPS for stats")
	flag.IntVar(&cfg.JPEGQuality, "jpeg-quality", cfg.JPEGQuality, "JPEG encoding quality 1-100 (lower = smaller bandwidth)")
	flag.StringVar(&logLevel, "log-level", "info", "Log level (debug, info, warn, error, silent)")
	flag.BoolVar(&logColor, "log-color", true, "Enable colored log output")
	flag.StringVar(&cfg.TLSCertFile, "tls-cert", "", "TLS certificate file (enables HTTPS)")
	flag.StringVar(&cfg.TLSKeyFile, "tls-key", "", "TLS private key file")
	flag.Parse()

	// Override recording path from env (matches systemd RECORDING_PATH)
	if v := os.Getenv("RECORDING_PATH"); v != "" {
		cfg.RecordingOutputPath = v
	}

	// Override detect port from env if not set via flag
	if v := os.Getenv("PET_CAMERA_DETECT_PORT"); v != "" {
		cfg.DetectPort = v
	}

	// Initialize logger
	level, err := logger.ParseLevel(logLevel)
	if err != nil {
		log.Fatalf("Invalid log level: %v", err)
	}
	logger.Init(level, os.Stderr, logColor)

	// Set JPEG quality for bandwidth control
	webmonitor.SetJPEGQuality(cfg.JPEGQuality)
	logger.Info("Main", "JPEG quality: %d", cfg.JPEGQuality)

	server := webmonitor.NewServer(cfg)

	// Start HTTP-only server for MJPEG stream if configured
	if httpOnlyAddr != "" {
		go func() {
			httpOnlyServer := &http.Server{
				Addr:    httpOnlyAddr,
				Handler: server.Handler(),
			}
			logger.Info("Main", "HTTP-only server listening on %s (MJPEG/API)", httpOnlyAddr)
			if err := httpOnlyServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("HTTP-only server error: %v", err)
			}
		}()
	}

	httpServer := &http.Server{
		Addr:    cfg.Addr,
		Handler: server.Handler(),
	}

	// Start HTTP(S) server in goroutine
	go func() {
		if cfg.TLSCertFile != "" && cfg.TLSKeyFile != "" {
			logger.Info("Main", "Go web monitor listening on %s (HTTPS)", cfg.Addr)
			logger.Info("Main", "TLS cert: %s", cfg.TLSCertFile)
			logger.Info("Main", "Assets: %s (build: %s)", cfg.AssetsDir, cfg.BuildAssetsDir)
			logger.Info("Main", "Log level: %s", level)
			if err := httpServer.ListenAndServeTLS(cfg.TLSCertFile, cfg.TLSKeyFile); err != nil && err != http.ErrServerClosed {
				log.Fatalf("server error: %v", err)
			}
		} else {
			logger.Info("Main", "Go web monitor listening on %s (HTTP)", cfg.Addr)
			logger.Info("Main", "Assets: %s (build: %s)", cfg.AssetsDir, cfg.BuildAssetsDir)
			logger.Info("Main", "Log level: %s", level)
			if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatalf("server error: %v", err)
			}
		}
	}()

	// Graceful shutdown on SIGINT/SIGTERM
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	logger.Info("Main", "Shutting down...")
	server.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Warn("Main", "HTTP shutdown error: %v", err)
	}
	logger.Info("Main", "Server stopped")
}
