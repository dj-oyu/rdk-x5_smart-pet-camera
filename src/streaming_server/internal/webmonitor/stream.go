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
	for y := range 480 {
		for x := range 640 {
			img.Set(x, y, color.RGBA{R: 8, G: 10, B: 18, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 75}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

type jpegProvider func() ([]byte, bool)

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
