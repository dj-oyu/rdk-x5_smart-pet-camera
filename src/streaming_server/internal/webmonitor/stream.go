package webmonitor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"time"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/internal/logger"
)

func writeSSE(w http.ResponseWriter, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "data: %s\n\n", data)
	return err
}

func blankJPEG() ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, 640, 480))

	// Color bars: White, Yellow, Cyan, Green, Magenta, Red, Blue, Black
	colors := []color.RGBA{
		{R: 255, G: 255, B: 255, A: 255}, // White
		{R: 255, G: 255, B: 0, A: 255},   // Yellow
		{R: 0, G: 255, B: 255, A: 255},   // Cyan
		{R: 0, G: 255, B: 0, A: 255},     // Green
		{R: 255, G: 0, B: 255, A: 255},   // Magenta
		{R: 255, G: 0, B: 0, A: 255},     // Red
		{R: 0, G: 0, B: 255, A: 255},     // Blue
		{R: 0, G: 0, B: 0, A: 255},       // Black
	}

	barWidth := 640 / len(colors)
	for y := range 480 {
		for x := range 640 {
			barIndex := x / barWidth
			if barIndex >= len(colors) {
				barIndex = len(colors) - 1
			}
			img.Set(x, y, colors[barIndex])
		}
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 75}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

type jpegProvider func() ([]byte, bool)

// streamMJPEGFromChannel streams MJPEG from a channel (fanout pattern).
func streamMJPEGFromChannel(w http.ResponseWriter, frameCh <-chan []byte) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=frame")
	w.Header().Set("Cache-Control", "no-cache")

	blank, err := blankJPEG()
	if err != nil {
		http.Error(w, "Failed to render frame", http.StatusInternalServerError)
		return
	}

	for {
		var jpegData []byte
		select {
		case data, ok := <-frameCh:
			if !ok {
				// Channel closed, client should disconnect
				return
			}
			if data != nil {
				jpegData = data
			} else {
				jpegData = blank
			}
		case <-time.After(5 * time.Second):
			// No frame for 5 seconds, send blank to keep connection alive
			jpegData = blank
		}

		// Write frame with error checking - if client disconnected, exit immediately
		if _, err := w.Write([]byte("--frame\r\nContent-Type: image/jpeg\r\n\r\n")); err != nil {
			// Client disconnected (e.g., switched to WebRTC)
			logger.Debug("MJPEG", "Client disconnected during write: %v", err)
			return
		}
		if _, err := w.Write(jpegData); err != nil {
			logger.Debug("MJPEG", "Client disconnected during frame write: %v", err)
			return
		}
		if _, err := w.Write([]byte("\r\n")); err != nil {
			logger.Debug("MJPEG", "Client disconnected during delimiter write: %v", err)
			return
		}
		flusher.Flush()
	}
}

func streamMJPEG(w http.ResponseWriter, interval time.Duration, provider jpegProvider) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=frame")
	w.Header().Set("Cache-Control", "no-cache")

	blank, err := blankJPEG()
	if err != nil {
		http.Error(w, "Failed to render frame", http.StatusInternalServerError)
		return
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		jpegData := blank
		if provider != nil {
			if data, ok := provider(); ok {
				jpegData = data
			}
		}

		_, _ = w.Write([]byte("--frame\r\nContent-Type: image/jpeg\r\n\r\n"))
		_, _ = w.Write(jpegData)
		_, _ = w.Write([]byte("\r\n"))
		flusher.Flush()

		<-ticker.C
	}
}

// streamDetectionEventsFromChannel streams pre-serialized detection events to SSE client.
// Data is already serialized in both formats by the broadcaster.
func streamDetectionEventsFromChannel(w http.ResponseWriter, eventCh <-chan *SerializedEvent, useProtobuf bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	// Add custom header to indicate format
	if useProtobuf {
		w.Header().Set("X-Content-Format", "application/protobuf")
	} else {
		w.Header().Set("X-Content-Format", "application/json")
	}

	for {
		select {
		case event, ok := <-eventCh:
			if !ok {
				// Channel closed, client should disconnect
				return
			}

			// Use pre-serialized data (no conversion needed)
			var data []byte
			if useProtobuf {
				data = event.ProtobufData
			} else {
				data = event.JSONData
			}

			// Send SSE event with error checking
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				// Client disconnected
				logger.Debug("SSE", "Client disconnected during event write: %v", err)
				return
			}
			flusher.Flush()

		case <-time.After(30 * time.Second):
			// Send keepalive comment to prevent timeout
			if _, err := fmt.Fprintf(w, ": keepalive\n\n"); err != nil {
				// Client disconnected
				logger.Debug("SSE", "Client disconnected during keepalive: %v", err)
				return
			}
			flusher.Flush()
		}
	}
}

// streamStatusEventsFromChannel streams pre-serialized status events to SSE client.
// Data is already serialized in both formats by the broadcaster.
func streamStatusEventsFromChannel(w http.ResponseWriter, eventCh <-chan *SerializedEvent, useProtobuf bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	// Add custom header to indicate format
	if useProtobuf {
		w.Header().Set("X-Content-Format", "application/protobuf")
	} else {
		w.Header().Set("X-Content-Format", "application/json")
	}

	for {
		select {
		case event, ok := <-eventCh:
			if !ok {
				// Channel closed, client should disconnect
				return
			}

			// Use pre-serialized data (no conversion needed)
			var data []byte
			if useProtobuf {
				data = event.ProtobufData
			} else {
				data = event.JSONData
			}

			// Send SSE event with error checking
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				// Client disconnected
				logger.Debug("SSE", "Client disconnected during status event write: %v", err)
				return
			}
			flusher.Flush()

		case <-time.After(30 * time.Second):
			// Send keepalive comment to prevent timeout
			if _, err := fmt.Fprintf(w, ": keepalive\n\n"); err != nil {
				// Client disconnected
				logger.Debug("SSE", "Client disconnected during keepalive: %v", err)
				return
			}
			flusher.Flush()
		}
	}
}

