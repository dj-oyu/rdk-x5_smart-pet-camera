package flaskcompat

import (
	"net/http"
	"os"
	"testing"
)

func TestFlaskCompatRecordingLifecycle(t *testing.T) {
	if os.Getenv("SPEC_RECORDING") == "" {
		t.Skip("set SPEC_RECORDING=1 to enable recording lifecycle spec")
	}
	client := newSpecClient(t)

	resp, body := client.get(t, "/api/recording/status")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/recording/status status = %d", resp.StatusCode)
	}
	payload := decodeJSONMap(t, body)
	if payload["recording"] == nil {
		t.Fatalf("recording status missing 'recording'")
	}

	resp, body = client.postJSON(t, "/api/recording/start", map[string]any{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/recording/start status = %d", resp.StatusCode)
	}
	startPayload := decodeJSONMap(t, body)
	status := requireString(t, startPayload["status"], "status")
	if status != "recording" {
		t.Fatalf("start status = %q", status)
	}
	requireString(t, startPayload["file"], "file")
	requireNumber(t, startPayload["started_at"], "started_at")

	resp, body = client.get(t, "/api/recording/status")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/recording/status status = %d", resp.StatusCode)
	}
	statusPayload := decodeJSONMap(t, body)
	if statusPayload["recording"] != true {
		t.Fatalf("recording status expected true, got %v", statusPayload["recording"])
	}
	requireNumber(t, statusPayload["frame_count"], "frame_count")
	requireNumber(t, statusPayload["bytes_written"], "bytes_written")

	resp, body = client.postJSON(t, "/api/recording/stop", map[string]any{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/recording/stop status = %d", resp.StatusCode)
	}
	stopPayload := decodeJSONMap(t, body)
	stopStatus := requireString(t, stopPayload["status"], "status")
	if stopStatus != "stopped" {
		t.Fatalf("stop status = %q", stopStatus)
	}
	requireString(t, stopPayload["file"], "file")
	requireNumber(t, stopPayload["stopped_at"], "stopped_at")
	requireMap(t, stopPayload["stats"], "stats")
}
