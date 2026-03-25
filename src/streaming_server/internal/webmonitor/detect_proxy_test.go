package webmonitor

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newDetectProxyServer creates a minimal Server with only the fields
// needed by handleDetectProxy (cfg.DetectPort and the http.Client).
func newDetectProxyServer(detectPort string) *Server {
	return &Server{
		cfg:    Config{DetectPort: detectPort},
		webrtc: &http.Client{},
	}
}

// startFakeDetector starts an httptest.Server on 127.0.0.1 that mimics
// the Python detector's /detect endpoint. It returns the server and its port.
func startFakeDetector(t *testing.T, handler http.HandlerFunc) (*httptest.Server, string) {
	t.Helper()
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	_, port, err := net.SplitHostPort(ts.Listener.Addr().String())
	if err != nil {
		t.Fatalf("parse listener addr: %v", err)
	}
	return ts, port
}

func TestHandleDetectProxy_Success(t *testing.T) {
	_, port := startFakeDetector(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/detect" {
			t.Errorf("expected /detect, got %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"image_url":"http://example.com/img.jpg"}` {
			t.Errorf("unexpected body: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"detections":[{"class":"cat","confidence":0.95}]}`))
	})

	s := newDetectProxyServer(port)
	reqBody := strings.NewReader(`{"image_url":"http://example.com/img.jpg"}`)
	req := httptest.NewRequest(http.MethodPost, "/detect", reqBody)
	rec := httptest.NewRecorder()

	s.handleDetectProxy(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected application/json, got %s", ct)
	}
	if cors := rec.Header().Get("Access-Control-Allow-Origin"); cors != "*" {
		t.Errorf("expected CORS *, got %s", cors)
	}
	respBody := rec.Body.String()
	if !strings.Contains(respBody, `"cat"`) {
		t.Errorf("response missing cat detection: %s", respBody)
	}
}

func TestHandleDetectProxy_MethodNotAllowed(t *testing.T) {
	s := newDetectProxyServer("9999")
	req := httptest.NewRequest(http.MethodGet, "/detect", nil)
	rec := httptest.NewRecorder()

	s.handleDetectProxy(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestHandleDetectProxy_BackendDown(t *testing.T) {
	// Use a port where nothing is listening
	s := newDetectProxyServer("19999")
	reqBody := strings.NewReader(`{"image_url":"http://example.com/img.jpg"}`)
	req := httptest.NewRequest(http.MethodPost, "/detect", reqBody)
	rec := httptest.NewRecorder()

	s.handleDetectProxy(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", rec.Code)
	}
}

func TestHandleDetectProxy_BackendError(t *testing.T) {
	_, port := startFakeDetector(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"model not loaded"}`))
	})

	s := newDetectProxyServer(port)
	reqBody := strings.NewReader(`{"image_url":"http://example.com/img.jpg"}`)
	req := httptest.NewRequest(http.MethodPost, "/detect", reqBody)
	rec := httptest.NewRecorder()

	s.handleDetectProxy(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", rec.Code)
	}
}
