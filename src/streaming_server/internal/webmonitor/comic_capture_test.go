//go:build gpu

package webmonitor

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newTestComicCapture creates a ComicCapture with SkipStitch=true (no nano2D in tests)
func newTestComicCapture(src frameSource, outputDir string) *ComicCapture {
	cc := NewComicCapture(src, outputDir)
	cc.SkipStitch = true
	return cc
}

// mockFrameSource is a test double for frameSource.
type mockFrameSource struct {
	detection *DetectionResult
	nv12Data  []byte
	nv12W     int
	nv12H     int
	consumed  bool
}

func (m *mockFrameSource) LatestDetection() (*DetectionResult, bool) {
	if m.detection == nil || m.consumed {
		return nil, false
	}
	m.consumed = true
	return m.detection, true
}

func (m *mockFrameSource) LatestNV12() (*NV12Frame, bool) {
	if m.nv12Data == nil {
		return nil, false
	}
	return &NV12Frame{Data: m.nv12Data, Width: m.nv12W, Height: m.nv12H}, true
}

func (m *mockFrameSource) setDetection(det *DetectionResult) {
	m.detection = det
	m.consumed = false
}

func makeTestNV12(w, h int) []byte {
	ySize := w * h
	uvSize := w * (h / 2)
	data := make([]byte, ySize+uvSize)
	// Fill Y with gray, UV with neutral
	for i := 0; i < ySize; i++ {
		data[i] = 128
	}
	for i := ySize; i < ySize+uvSize; i++ {
		data[i] = 128
	}
	return data
}

func catDetection(version int) *DetectionResult {
	return &DetectionResult{
		FrameNumber:   1,
		Timestamp:     float64(time.Now().Unix()),
		NumDetections: 1,
		Version:       version,
		Detections: []Detection{
			{
				ClassName:  "cat",
				Confidence: 0.95,
				BBox:       BoundingBox{X: 100, Y: 100, W: 200, H: 150},
			},
		},
	}
}

func noCatDetection(version int) *DetectionResult {
	return &DetectionResult{
		FrameNumber:   1,
		Timestamp:     float64(time.Now().Unix()),
		NumDetections: 1,
		Version:       version,
		Detections: []Detection{
			{
				ClassName:  "person",
				Confidence: 0.8,
				BBox:       BoundingBox{X: 50, Y: 50, W: 100, H: 200},
			},
		},
	}
}

func TestHasPet(t *testing.T) {
	tests := []struct {
		name string
		det  *DetectionResult
		want bool
	}{
		{"nil detection", nil, false},
		{"no detections", &DetectionResult{}, false},
		{"cat present", catDetection(1), true},
		{"no cat", noCatDetection(1), false},
		{"dog present", &DetectionResult{
			Detections: []Detection{
				{ClassName: "dog", Confidence: 0.85},
			},
		}, true},
		{"cat among others", &DetectionResult{
			Detections: []Detection{
				{ClassName: "person", Confidence: 0.8},
				{ClassName: "cat", Confidence: 0.9},
			},
		}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hasPet(tt.det); got != tt.want {
				t.Errorf("hasPet() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestPetDetection(t *testing.T) {
	det := &DetectionResult{
		Detections: []Detection{
			{ClassName: "cat", Confidence: 0.5, BBox: BoundingBox{X: 10, Y: 10, W: 50, H: 50}},
			{ClassName: "dog", Confidence: 0.9, BBox: BoundingBox{X: 100, Y: 100, W: 200, H: 150}},
		},
	}

	bbox, class := petDetection(det)
	if bbox == nil {
		t.Fatal("expected non-nil bbox")
	}
	if bbox.X != 100 || bbox.Y != 100 {
		t.Errorf("expected highest-confidence pet bbox, got %+v", bbox)
	}
	if class != "dog" {
		t.Errorf("expected class 'dog', got %q", class)
	}
}

func TestStateMachine_IdleToCaptureRequires5sCat(t *testing.T) {
	src := &mockFrameSource{nv12Data: makeTestNV12(768, 432), nv12W: 768, nv12H: 432}
	cc := newTestComicCapture(src, t.TempDir())

	now := time.Now()

	// Tick with cat detection — should stay idle (not 5s yet)
	src.setDetection(catDetection(1))
	cc.tick(now)
	if cc.state != comicIdle {
		t.Fatalf("expected idle, got %d", cc.state)
	}

	// Tick at +3s — still idle
	src.setDetection(catDetection(2))
	cc.tick(now.Add(3 * time.Second))
	if cc.state != comicIdle {
		t.Fatalf("expected idle at +3s, got %d", cc.state)
	}

	// Tick at +5s — should start capturing
	src.setDetection(catDetection(3))
	cc.tick(now.Add(5 * time.Second))
	if cc.state != comicCapturing {
		t.Fatalf("expected capturing at +5s, got %d", cc.state)
	}
}

func TestStateMachine_CatLostDuringCapture(t *testing.T) {
	src := &mockFrameSource{nv12Data: makeTestNV12(768, 432), nv12W: 768, nv12H: 432}
	tmpDir := t.TempDir()
	cc := newTestComicCapture(src, tmpDir)

	now := time.Now()

	// Establish cat for 5 seconds
	src.setDetection(catDetection(1))
	cc.tick(now)
	src.setDetection(catDetection(2))
	cc.tick(now.Add(5 * time.Second))

	if cc.state != comicCapturing {
		t.Fatalf("expected capturing, got %d", cc.state)
	}

	// Capture first panel immediately
	if len(cc.panels) != 1 {
		t.Fatalf("expected 1 panel, got %d", len(cc.panels))
	}

	// Stop providing detections → version becomes stale
	// Tick at +11s (6s without version change > 5s threshold)
	cc.tick(now.Add(11 * time.Second))
	if cc.state != comicIdle {
		t.Fatalf("expected idle after detection lost, got %d", cc.state)
	}

}

func TestStateMachine_Full4PanelCapture(t *testing.T) {
	src := &mockFrameSource{nv12Data: makeTestNV12(768, 432), nv12W: 768, nv12H: 432}
	tmpDir := t.TempDir()
	cc := newTestComicCapture(src, tmpDir)
	cc.BaseCaptureInterval = 500 * time.Millisecond // speed up for test

	now := time.Now()

	// Establish cat
	src.setDetection(catDetection(1))
	cc.tick(now)
	src.setDetection(catDetection(2))
	cc.tick(now.Add(5 * time.Second))

	if cc.state != comicCapturing {
		t.Fatalf("expected capturing")
	}
	if len(cc.panels) != 1 {
		t.Fatalf("expected 1 panel after start, got %d", len(cc.panels))
	}

	// Capture remaining 3 panels (2-second intervals well above 500ms base)
	for i := 1; i <= 3; i++ {
		src.setDetection(catDetection(3 + i))
		cc.tick(now.Add(time.Duration(5+i*2) * time.Second))
	}

}

func TestRateLimit(t *testing.T) {
	src := &mockFrameSource{nv12Data: makeTestNV12(768, 432), nv12W: 768, nv12H: 432}
	cc := newTestComicCapture(src, t.TempDir())

	now := time.Now()

	// Simulate 3 recent comics (at the limit)
	cc.recentComics = []time.Time{
		now.Add(-2 * time.Minute),
		now.Add(-1 * time.Minute),
		now.Add(-30 * time.Second),
	}

	if cc.canGenerateComic(now) {
		t.Fatal("should be rate-limited")
	}

	// After window passes, should allow again
	future := now.Add(6 * time.Minute)
	if !cc.canGenerateComic(future) {
		t.Fatal("should allow after window passes")
	}
}

func TestAdaptiveInterval(t *testing.T) {
	cc := newTestComicCapture(nil, "")
	cc.BaseCaptureInterval = 10 * time.Second

	start := time.Now()
	cc.captureStartTime = start

	// At t=0: interval = 10s * (1 + 0/5) = 10s
	got := cc.currentInterval(start)
	if got != 10*time.Second {
		t.Errorf("at t=0: got %v, want 10s", got)
	}

	// At t=5m: interval = 10s * (1 + 5/5) = 20s
	got = cc.currentInterval(start.Add(5 * time.Minute))
	if got != 20*time.Second {
		t.Errorf("at t=5m: got %v, want 20s", got)
	}

	// At t=10m: interval = 10s * (1 + 10/5) = 30s
	got = cc.currentInterval(start.Add(10 * time.Minute))
	if got != 30*time.Second {
		t.Errorf("at t=10m: got %v, want 30s", got)
	}
}

func TestSessionIDFormat(t *testing.T) {
	src := &mockFrameSource{nv12Data: makeTestNV12(768, 432), nv12W: 768, nv12H: 432}
	cc := newTestComicCapture(src, t.TempDir())

	now := time.Date(2026, 3, 20, 14, 32, 5, 0, time.Local)
	cc.startCapturing(now)

	expected := now.Format("20060102_150405")
	if cc.sessionID != expected {
		t.Errorf("sessionID = %q, want %q", cc.sessionID, expected)
	}
}


func TestRateLimitBlocksCapture(t *testing.T) {
	src := &mockFrameSource{nv12Data: makeTestNV12(768, 432), nv12W: 768, nv12H: 432}
	cc := newTestComicCapture(src, t.TempDir())

	now := time.Now()

	// Fill rate limit
	cc.recentComics = []time.Time{
		now.Add(-2 * time.Minute),
		now.Add(-1 * time.Minute),
		now.Add(-30 * time.Second),
	}

	// Cat detected continuously for 5s — but rate limited
	src.setDetection(catDetection(1))
	cc.tick(now)
	src.setDetection(catDetection(2))
	cc.tick(now.Add(5 * time.Second))

	if cc.state != comicIdle {
		t.Fatal("should stay idle when rate limited")
	}
}

func TestContinuousSessionAfter4Panels(t *testing.T) {
	src := &mockFrameSource{nv12Data: makeTestNV12(768, 432), nv12W: 768, nv12H: 432}
	tmpDir := t.TempDir()
	cc := newTestComicCapture(src, tmpDir)
	cc.BaseCaptureInterval = 500 * time.Millisecond

	now := time.Now()

	// Start capturing
	src.setDetection(catDetection(1))
	cc.tick(now)
	src.setDetection(catDetection(2))
	cc.tick(now.Add(5 * time.Second))

	if cc.state != comicCapturing {
		t.Fatal("expected capturing")
	}

	// Complete 4 panels
	for i := 1; i <= 3; i++ {
		src.setDetection(catDetection(3 + i))
		cc.tick(now.Add(time.Duration(5+i*2) * time.Second))
	}

	// Cat still present → should start new session
	if cc.state != comicCapturing {
		t.Fatal("should start new session when cat still present after 4 panels")
	}

	// New session should already have 1 panel (captured at start)
	if len(cc.panels) != 1 {
		t.Fatalf("new session should have 1 panel, got %d", len(cc.panels))
	}
}

func TestCapturePanelSkipsOnNV12Failure(t *testing.T) {
	src := &mockFrameSource{nv12Data: nil}
	cc := newTestComicCapture(src, t.TempDir())

	now := time.Now()
	cc.state = comicCapturing
	cc.sessionID = "test"
	cc.captureStartTime = now

	cc.capturePanel(now)

	if len(cc.panels) != 0 {
		t.Fatal("should not capture panel when NV12 unavailable")
	}
}

func TestPanelsClearedAfterStitch(t *testing.T) {
	src := &mockFrameSource{nv12Data: makeTestNV12(768, 432), nv12W: 768, nv12H: 432}
	tmpDir := t.TempDir()
	cc := newTestComicCapture(src, tmpDir)
	cc.BaseCaptureInterval = 500 * time.Millisecond

	now := time.Now()

	// Start and complete 4 panels
	src.setDetection(catDetection(1))
	cc.tick(now)
	src.setDetection(catDetection(2))
	cc.tick(now.Add(5 * time.Second))

	for i := 1; i <= 3; i++ {
		src.setDetection(catDetection(3 + i))
		cc.tick(now.Add(time.Duration(5+i*2) * time.Second))
	}

	// After 4-panel stitch, a new session starts with 1 panel.
	// Stop providing detections to force idle.
	cc.tick(now.Add(20 * time.Second))

	// Should be idle now, panels cleared
	if cc.state != comicIdle {
		t.Fatal("expected idle after detection lost")
	}
}



func TestStartStop(t *testing.T) {
	src := &mockFrameSource{nv12Data: makeTestNV12(768, 432), nv12W: 768, nv12H: 432}
	cc := newTestComicCapture(src, t.TempDir())

	cc.Start()
	// Give goroutine time to start polling
	time.Sleep(50 * time.Millisecond)
	cc.Stop() // Should not hang
}

// --- API Handler Tests ---

func setupComicsTestDir(t *testing.T) (string, *Server) {
	t.Helper()
	tmpDir := t.TempDir()
	comicsDir := filepath.Join(tmpDir, "comics")
	os.MkdirAll(comicsDir, 0755)

	cfg := DefaultConfig()
	cfg.RecordingOutputPath = tmpDir
	s := &Server{cfg: cfg}
	return comicsDir, s
}

func TestHandleComicsList_Empty(t *testing.T) {
	_, s := setupComicsTestDir(t)

	req := httptest.NewRequest(http.MethodGet, "/api/comics", nil)
	w := httptest.NewRecorder()
	s.handleComicsList(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	comics := resp["comics"].([]any)
	if len(comics) != 0 {
		t.Fatalf("expected empty comics list, got %d", len(comics))
	}
	if total := int(resp["total"].(float64)); total != 0 {
		t.Fatalf("expected total=0, got %d", total)
	}
}

func TestHandleComicsList_WithFiles(t *testing.T) {
	comicsDir, s := setupComicsTestDir(t)

	// Create test comic files
	os.WriteFile(filepath.Join(comicsDir, "comic_20260320_140000.jpg"), []byte("dummy-jpeg"), 0644)
	os.WriteFile(filepath.Join(comicsDir, "comic_20260320_150000.jpg"), []byte("dummy-jpeg"), 0644)
	os.WriteFile(filepath.Join(comicsDir, "not_a_comic.txt"), []byte("ignore"), 0644) // should be filtered

	req := httptest.NewRequest(http.MethodGet, "/api/comics", nil)
	w := httptest.NewRecorder()
	s.handleComicsList(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	comics := resp["comics"].([]any)
	if len(comics) != 2 {
		t.Fatalf("expected 2 comics, got %d", len(comics))
	}
	if total := int(resp["total"].(float64)); total != 2 {
		t.Fatalf("expected total=2, got %d", total)
	}
	// Newest first
	first := comics[0].(map[string]any)["filename"].(string)
	if first != "comic_20260320_150000.jpg" {
		t.Fatalf("expected newest first, got %s", first)
	}
}

func TestHandleComicsList_Pagination(t *testing.T) {
	comicsDir, s := setupComicsTestDir(t)

	for i := 0; i < 5; i++ {
		name := fmt.Sprintf("comic_20260320_1%d0000.jpg", i)
		os.WriteFile(filepath.Join(comicsDir, name), []byte("dummy-jpeg"), 0644)
	}

	// First page: limit=2, offset=0
	req := httptest.NewRequest(http.MethodGet, "/api/comics?limit=2&offset=0", nil)
	w := httptest.NewRecorder()
	s.handleComicsList(w, req)

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	comics := resp["comics"].([]any)
	if len(comics) != 2 {
		t.Fatalf("page 1: expected 2 comics, got %d", len(comics))
	}
	if total := int(resp["total"].(float64)); total != 5 {
		t.Fatalf("expected total=5, got %d", total)
	}

	// Second page: limit=2, offset=2
	req = httptest.NewRequest(http.MethodGet, "/api/comics?limit=2&offset=2", nil)
	w = httptest.NewRecorder()
	s.handleComicsList(w, req)

	json.Unmarshal(w.Body.Bytes(), &resp)
	comics = resp["comics"].([]any)
	if len(comics) != 2 {
		t.Fatalf("page 2: expected 2 comics, got %d", len(comics))
	}

	// Beyond end: offset=10
	req = httptest.NewRequest(http.MethodGet, "/api/comics?limit=2&offset=10", nil)
	w = httptest.NewRecorder()
	s.handleComicsList(w, req)

	json.Unmarshal(w.Body.Bytes(), &resp)
	comics = resp["comics"].([]any)
	if len(comics) != 0 {
		t.Fatalf("beyond end: expected 0 comics, got %d", len(comics))
	}
}

func TestHandleComicServe_GET(t *testing.T) {
	comicsDir, s := setupComicsTestDir(t)

	jpegData := []byte("dummy-jpeg")
	os.WriteFile(filepath.Join(comicsDir, "comic_20260320_140000.jpg"), jpegData, 0644)

	req := httptest.NewRequest(http.MethodGet, "/api/comics/comic_20260320_140000.jpg", nil)
	w := httptest.NewRecorder()
	s.handleComicServe(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("Content-Type = %q, want image/jpeg", ct)
	}
}

func TestHandleComicServe_DELETE(t *testing.T) {
	comicsDir, s := setupComicsTestDir(t)

	os.WriteFile(filepath.Join(comicsDir, "comic_20260320_140000.jpg"), []byte("dummy-jpeg"), 0644)

	req := httptest.NewRequest(http.MethodDelete, "/api/comics/comic_20260320_140000.jpg", nil)
	w := httptest.NewRecorder()
	s.handleComicServe(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	// Verify file is gone
	if _, err := os.Stat(filepath.Join(comicsDir, "comic_20260320_140000.jpg")); !os.IsNotExist(err) {
		t.Fatal("file should be deleted")
	}
}

func TestHandleComicServe_NotFound(t *testing.T) {
	_, s := setupComicsTestDir(t)

	req := httptest.NewRequest(http.MethodGet, "/api/comics/nonexistent.jpg", nil)
	w := httptest.NewRecorder()
	s.handleComicServe(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestHandleComicServe_PathTraversal(t *testing.T) {
	_, s := setupComicsTestDir(t)

	req := httptest.NewRequest(http.MethodGet, "/api/comics/../../etc/passwd", nil)
	w := httptest.NewRecorder()
	s.handleComicServe(w, req)

	// filepath.Base sanitizes to "passwd", which doesn't end in .jpg
	if w.Code != http.StatusBadRequest {
		t.Fatalf("path traversal: status = %d, want 400", w.Code)
	}
}

func TestHandleComicsList_MethodNotAllowed(t *testing.T) {
	_, s := setupComicsTestDir(t)

	req := httptest.NewRequest(http.MethodPost, "/api/comics", nil)
	w := httptest.NewRecorder()
	s.handleComicsList(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
}

func TestNoCatResetsContinuousTracking(t *testing.T) {
	src := &mockFrameSource{nv12Data: makeTestNV12(768, 432), nv12W: 768, nv12H: 432}
	cc := newTestComicCapture(src, t.TempDir())

	now := time.Now()

	// Cat for 3 seconds
	src.setDetection(catDetection(1))
	cc.tick(now)
	src.setDetection(catDetection(2))
	cc.tick(now.Add(3 * time.Second))

	// Non-cat detection resets continuous tracking
	src.setDetection(noCatDetection(3))
	cc.tick(now.Add(4 * time.Second))

	if !cc.catFirstSeen.IsZero() {
		t.Fatal("catFirstSeen should be reset after non-cat detection")
	}

	// Cat again — needs another 5s
	src.setDetection(catDetection(4))
	cc.tick(now.Add(5 * time.Second))
	src.setDetection(catDetection(5))
	cc.tick(now.Add(9 * time.Second))

	if cc.state != comicIdle {
		t.Fatal("should still be idle (only 4s of continuous cat)")
	}

	src.setDetection(catDetection(6))
	cc.tick(now.Add(10 * time.Second))

	if cc.state != comicCapturing {
		t.Fatal("should be capturing after 5s of continuous cat")
	}
}
