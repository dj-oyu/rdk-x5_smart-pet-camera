package flaskcompat

import (
	"net/http"
	"strings"
	"testing"
)

func TestFlaskCompatIndex(t *testing.T) {
	client := newSpecClient(t)
	resp, body := client.get(t, "/")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / status = %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("GET / content-type = %q", resp.Header.Get("Content-Type"))
	}
	html := string(body)
	mustContain := []string{
		"<title>Smart Pet Camera Monitor</title>",
		"/assets/monitor.css",
		"/assets/monitor.js",
		"/assets/webrtc_client.js",
		"/assets/bbox_overlay.js",
	}
	for _, needle := range mustContain {
		if !strings.Contains(html, needle) {
			t.Fatalf("GET / missing %q", needle)
		}
	}
}

func TestFlaskCompatAssets(t *testing.T) {
	client := newSpecClient(t)
	resp, body := client.get(t, "/assets/monitor.css")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /assets/monitor.css status = %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/css") {
		t.Fatalf("monitor.css content-type = %q", resp.Header.Get("Content-Type"))
	}
	if !strings.Contains(string(body), ":root") {
		t.Fatalf("monitor.css missing :root")
	}

	resp, body = client.get(t, "/assets/monitor.js")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /assets/monitor.js status = %d", resp.StatusCode)
	}
	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "application/javascript") &&
		!strings.Contains(contentType, "text/javascript") {
		t.Fatalf("monitor.js content-type = %q", contentType)
	}
	if !strings.Contains(string(body), "/api/status") {
		t.Fatalf("monitor.js missing /api/status usage")
	}
}

func TestFlaskCompatStatus(t *testing.T) {
	client := newSpecClient(t)
	resp, body := client.get(t, "/api/status")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/status status = %d", resp.StatusCode)
	}
	payload := decodeJSONMap(t, body)
	assertStatusPayload(t, payload)
}

func TestFlaskCompatCameraStatus(t *testing.T) {
	client := newSpecClient(t)
	resp, body := client.get(t, "/api/camera_status")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/camera_status status = %d", resp.StatusCode)
	}
	payload := decodeJSONMap(t, body)
	camera := requireMap(t, payload["camera"], "camera")
	requireString(t, camera["mode"], "camera.mode")

	monitor := requireMap(t, payload["monitor"], "monitor")
	requireNumber(t, monitor["frames_processed"], "monitor.frames_processed")
	requireNumber(t, monitor["current_fps"], "monitor.current_fps")
	requireNumber(t, monitor["detection_count"], "monitor.detection_count")
	requireNumber(t, monitor["target_fps"], "monitor.target_fps")

	shm := requireMap(t, payload["shared_memory"], "shared_memory")
	requireNumber(t, shm["frame_count"], "shared_memory.frame_count")
	requireNumber(t, shm["total_frames_written"], "shared_memory.total_frames_written")
	requireNumber(t, shm["detection_version"], "shared_memory.detection_version")
	requireNumber(t, shm["has_detection"], "shared_memory.has_detection")
}

func TestFlaskCompatWebRTCOfferInvalid(t *testing.T) {
	client := newSpecClient(t)
	resp, body := client.postJSON(t, "/api/webrtc/offer", map[string]any{})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST /api/webrtc/offer status = %d", resp.StatusCode)
	}
	payload := decodeJSONMap(t, body)
	if requireString(t, payload["error"], "error") != "Invalid offer data" {
		t.Fatalf("unexpected error: %v", payload["error"])
	}
}
