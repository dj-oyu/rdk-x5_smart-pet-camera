package flaskcompat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

const (
	defaultBaseURL        = "http://localhost:8080"
	defaultRequestTimeout = 2 * time.Second
)

type specClient struct {
	baseURL string
	client  *http.Client
}

func newSpecClient(t *testing.T) *specClient {
	t.Helper()
	baseURL := os.Getenv("SPEC_BASE_URL")
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	client := &http.Client{Timeout: defaultRequestTimeout}

	if !isReachable(client, baseURL+"/api/status") {
		t.Skipf("spec server not reachable at %s (set SPEC_BASE_URL to run)", baseURL)
	}

	return &specClient{
		baseURL: baseURL,
		client:  client,
	}
}

func isReachable(client *http.Client, url string) bool {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 500
}

func (c *specClient) get(t *testing.T, path string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	_ = resp.Body.Close()
	return resp, body
}

func (c *specClient) getResponse(t *testing.T, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	return resp
}

func (c *specClient) postJSON(t *testing.T, path string, payload any) (*http.Response, []byte) {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, c.baseURL+path, bytes.NewReader(data))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	_ = resp.Body.Close()
	return resp, body
}

func readSSEEvent(url string, timeout time.Duration) (string, http.Header, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", nil, fmt.Errorf("build request: %w", err)
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return "", nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 256)
	for {
		n, readErr := resp.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			if idx := bytes.Index(buf, []byte("\n\n")); idx >= 0 {
				event := string(buf[:idx])
				return event, resp.Header, nil
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return "", nil, fmt.Errorf("sse stream closed before event")
			}
			return "", nil, fmt.Errorf("read sse: %w", readErr)
		}
		select {
		case <-ctx.Done():
			return "", nil, fmt.Errorf("timeout waiting for sse event")
		default:
		}
	}
}

func parseSSEData(t *testing.T, event string) map[string]any {
	t.Helper()
	lines := strings.Split(event, "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "" {
				t.Fatalf("empty sse data line")
			}
			return decodeJSONMap(t, []byte(payload))
		}
	}
	t.Fatalf("no data line in sse event: %q", event)
	return nil
}

func decodeJSONMap(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode json: %v\nbody=%s", err, string(body))
	}
	return payload
}

func requireString(t *testing.T, value any, field string) string {
	t.Helper()
	str, ok := value.(string)
	if !ok {
		t.Fatalf("expected %s to be string, got %T", field, value)
	}
	return str
}

func requireNumber(t *testing.T, value any, field string) float64 {
	t.Helper()
	num, ok := value.(float64)
	if !ok {
		t.Fatalf("expected %s to be number, got %T", field, value)
	}
	return num
}

func requireMap(t *testing.T, value any, field string) map[string]any {
	t.Helper()
	m, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("expected %s to be object, got %T", field, value)
	}
	return m
}

func requireSlice(t *testing.T, value any, field string) []any {
	t.Helper()
	s, ok := value.([]any)
	if !ok {
		t.Fatalf("expected %s to be array, got %T", field, value)
	}
	return s
}

func assertDetectionPayload(t *testing.T, payload map[string]any) {
	t.Helper()
	requireNumber(t, payload["frame_number"], "frame_number")
	requireNumber(t, payload["timestamp"], "timestamp")
	detections := requireSlice(t, payload["detections"], "detections")
	for i, raw := range detections {
		det := requireMap(t, raw, fmt.Sprintf("detections[%d]", i))
		requireString(t, det["class_name"], "detections.class_name")
		requireNumber(t, det["confidence"], "detections.confidence")
		bbox := requireMap(t, det["bbox"], "detections.bbox")
		requireNumber(t, bbox["x"], "detections.bbox.x")
		requireNumber(t, bbox["y"], "detections.bbox.y")
		requireNumber(t, bbox["w"], "detections.bbox.w")
		requireNumber(t, bbox["h"], "detections.bbox.h")
	}
}

func assertDetectionHistoryEntry(t *testing.T, payload map[string]any, field string) {
	t.Helper()
	requireNumber(t, payload["frame_number"], field+".frame_number")
	requireNumber(t, payload["timestamp"], field+".timestamp")
	requireNumber(t, payload["num_detections"], field+".num_detections")
	requireNumber(t, payload["version"], field+".version")
	requireSlice(t, payload["detections"], field+".detections")
}

func assertStatusPayload(t *testing.T, payload map[string]any) {
	t.Helper()
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

	requireNumber(t, payload["timestamp"], "timestamp")

	if payload["latest_detection"] != nil {
		latest := requireMap(t, payload["latest_detection"], "latest_detection")
		assertDetectionHistoryEntry(t, latest, "latest_detection")
	}

	history := requireSlice(t, payload["detection_history"], "detection_history")
	for i, raw := range history {
		item := requireMap(t, raw, fmt.Sprintf("detection_history[%d]", i))
		assertDetectionHistoryEntry(t, item, fmt.Sprintf("detection_history[%d]", i))
	}
}

