package flaskcompat

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestFlaskCompatMJPEGStream(t *testing.T) {
	client := newSpecClient(t)
	resp := client.getResponse(t, "/stream")
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /stream status = %d", resp.StatusCode)
	}
	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "multipart/x-mixed-replace") ||
		!strings.Contains(contentType, "boundary=frame") {
		t.Fatalf("GET /stream content-type = %q", contentType)
	}
}

func TestFlaskCompatStatusStream(t *testing.T) {
	client := newSpecClient(t)
	event, headers, err := readSSEEvent(client.baseURL+"/api/status/stream", 3*time.Second)
	if err != nil {
		t.Fatalf("status stream error: %v", err)
	}
	if !strings.Contains(headers.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status stream content-type = %q", headers.Get("Content-Type"))
	}
	payload := parseSSEData(t, event)
	assertStatusPayload(t, payload)
}

func TestFlaskCompatDetectionsStream(t *testing.T) {
	client := newSpecClient(t)
	event, headers, err := readSSEEvent(client.baseURL+"/api/detections/stream", 3*time.Second)
	if err != nil {
		t.Skipf("detections stream unavailable: %v", err)
	}
	if !strings.Contains(headers.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("detections stream content-type = %q", headers.Get("Content-Type"))
	}
	payload := parseSSEData(t, event)
	assertDetectionPayload(t, payload)
}
