package webmonitor

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	h := NewDetectionHistory(24 * time.Hour)

	now := float64(time.Now().Unix())
	h.Record(&DetectionResult{
		Timestamp:  now - 100,
		Detections: []Detection{{ClassName: "cat", Confidence: 0.9}},
	})
	h.Record(&DetectionResult{
		Timestamp:  now - 50,
		Detections: []Detection{{ClassName: "person", Confidence: 0.8}, {ClassName: "cat", Confidence: 0.7}},
	})

	dir := t.TempDir()
	path := filepath.Join(dir, "history.gob")

	if err := h.Save(path); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file not created: %v", err)
	}

	h2 := NewDetectionHistory(24 * time.Hour)
	if err := h2.Load(path); err != nil {
		t.Fatalf("Load: %v", err)
	}

	records := h2.Records()
	if len(records) != 2 {
		t.Fatalf("expected 2 records, got %d", len(records))
	}
	if records[0].Classes[0] != "cat" {
		t.Errorf("expected cat, got %s", records[0].Classes[0])
	}
	if len(records[1].Classes) != 2 {
		t.Errorf("expected 2 classes, got %d", len(records[1].Classes))
	}
}

func TestLoadNonExistent(t *testing.T) {
	h := NewDetectionHistory(24 * time.Hour)
	if err := h.Load("/nonexistent/path.gob"); err != nil {
		t.Fatalf("Load nonexistent should return nil, got: %v", err)
	}
	if len(h.Records()) != 0 {
		t.Error("expected empty records")
	}
}

func TestLoadTrimsExpired(t *testing.T) {
	h := NewDetectionHistory(1 * time.Hour)

	now := float64(time.Now().Unix())
	// One record from 2 hours ago (expired), one from 30 min ago (valid)
	h.Record(&DetectionResult{
		Timestamp:  now - 7200,
		Detections: []Detection{{ClassName: "old"}},
	})
	h.Record(&DetectionResult{
		Timestamp:  now - 1800,
		Detections: []Detection{{ClassName: "recent"}},
	})

	dir := t.TempDir()
	path := filepath.Join(dir, "history.gob")
	if err := h.Save(path); err != nil {
		t.Fatalf("Save: %v", err)
	}

	h2 := NewDetectionHistory(1 * time.Hour)
	if err := h2.Load(path); err != nil {
		t.Fatalf("Load: %v", err)
	}

	records := h2.Records()
	if len(records) != 1 {
		t.Fatalf("expected 1 record after trim, got %d", len(records))
	}
	if records[0].Classes[0] != "recent" {
		t.Errorf("expected 'recent', got %s", records[0].Classes[0])
	}
}

func TestSaveEmptyNoFile(t *testing.T) {
	h := NewDetectionHistory(24 * time.Hour)
	dir := t.TempDir()
	path := filepath.Join(dir, "history.gob")

	if err := h.Save(path); err != nil {
		t.Fatalf("Save empty: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("expected no file for empty history")
	}
}
