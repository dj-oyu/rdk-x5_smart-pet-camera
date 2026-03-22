package webmonitor

import (
	"encoding/gob"
	"errors"
	"io/fs"
	"os"
	"sync"
	"time"
)

// DetectionHistoryRecord is a single timestamped detection summary.
type DetectionHistoryRecord struct {
	Timestamp float64  `json:"timestamp"`
	Classes   []string `json:"classes"`
}

// DetectionHistory stores a rolling window of detection summaries.
type DetectionHistory struct {
	mu      sync.RWMutex
	records []DetectionHistoryRecord
	window  time.Duration
}

// NewDetectionHistory creates a history store with the given retention window.
func NewDetectionHistory(window time.Duration) *DetectionHistory {
	return &DetectionHistory{
		records: make([]DetectionHistoryRecord, 0, 8192),
		window:  window,
	}
}

// Record adds a detection event to the history.
func (h *DetectionHistory) Record(det *DetectionResult) {
	if det == nil || len(det.Detections) == 0 {
		return
	}

	seen := make(map[string]struct{})
	classes := make([]string, 0, len(det.Detections))
	for _, d := range det.Detections {
		if _, ok := seen[d.ClassName]; !ok {
			seen[d.ClassName] = struct{}{}
			classes = append(classes, d.ClassName)
		}
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	h.records = append(h.records, DetectionHistoryRecord{
		Timestamp: det.Timestamp,
		Classes:   classes,
	})

	// Trim old records
	cutoff := float64(time.Now().Unix()) - h.window.Seconds()
	trimIdx := 0
	for trimIdx < len(h.records) && h.records[trimIdx].Timestamp < cutoff {
		trimIdx++
	}
	if trimIdx > 0 {
		h.records = h.records[trimIdx:]
	}
}

// Records returns all records within the retention window.
func (h *DetectionHistory) Records() []DetectionHistoryRecord {
	h.mu.RLock()
	defer h.mu.RUnlock()

	out := make([]DetectionHistoryRecord, len(h.records))
	copy(out, h.records)
	return out
}

// Save writes all records to a gob file atomically (temp + rename).
func (h *DetectionHistory) Save(path string) error {
	h.mu.RLock()
	records := make([]DetectionHistoryRecord, len(h.records))
	copy(records, h.records)
	h.mu.RUnlock()

	if len(records) == 0 {
		return nil
	}

	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := gob.NewEncoder(f).Encode(records); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// Load reads records from a gob file, keeping only those within the retention window.
func (h *DetectionHistory) Load(path string) error {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	defer f.Close()

	var records []DetectionHistoryRecord
	if err := gob.NewDecoder(f).Decode(&records); err != nil {
		return err
	}

	cutoff := float64(time.Now().Unix()) - h.window.Seconds()
	trimIdx := 0
	for trimIdx < len(records) && records[trimIdx].Timestamp < cutoff {
		trimIdx++
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = records[trimIdx:]
	return nil
}
