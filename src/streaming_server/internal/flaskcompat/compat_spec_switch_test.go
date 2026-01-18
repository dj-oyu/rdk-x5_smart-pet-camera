package flaskcompat

import (
	"net/http"
	"os"
	"testing"
)

func TestFlaskCompatCameraSwitch(t *testing.T) {
	if os.Getenv("SPEC_SWITCH_CAMERA") == "" {
		t.Skip("set SPEC_SWITCH_CAMERA=1 to enable camera switch spec")
	}
	client := newSpecClient(t)
	resp, body := client.get(t, "/api/camera_status")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/camera_status status = %d", resp.StatusCode)
	}
	payload := decodeJSONMap(t, body)
	camera := requireMap(t, payload["camera"], "camera")
	mode := requireString(t, camera["mode"], "camera.mode")

	resp, body = client.postJSON(t, "/api/debug/switch-camera", map[string]any{
		"mode": "auto",
	})
	if mode == "unavailable" {
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("POST /api/debug/switch-camera status = %d", resp.StatusCode)
		}
		errorPayload := decodeJSONMap(t, body)
		requireString(t, errorPayload["error"], "error")
		return
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/debug/switch-camera status = %d", resp.StatusCode)
	}
	okPayload := decodeJSONMap(t, body)
	if okPayload["ok"] != true {
		t.Fatalf("expected ok=true, got %v", okPayload["ok"])
	}
	requireString(t, okPayload["mode"], "mode")
	requireMap(t, okPayload["status"], "status")
}
