package webmonitor

// BoundingBox mirrors the JSON shape used by the Flask monitor APIs.
type BoundingBox struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// Detection mirrors the JSON shape used by the Flask monitor APIs.
type Detection struct {
	ClassName  string      `json:"class_name"`
	Confidence float64     `json:"confidence"`
	BBox       BoundingBox `json:"bbox"`
}

// DetectionResult mirrors the JSON shape used by the Flask monitor APIs.
type DetectionResult struct {
	FrameNumber   int         `json:"frame_number"`
	Timestamp     float64     `json:"timestamp"`
	NumDetections int         `json:"num_detections"`
	Version       int         `json:"version"`
	Detections    []Detection `json:"detections"`
}

// DetectionEvent is the payload for /api/detections/stream.
type DetectionEvent struct {
	FrameNumber int         `json:"frame_number"`
	Timestamp   float64     `json:"timestamp"`
	Detections  []Detection `json:"detections"`
}

// MonitorStats mirrors the JSON shape used by the Flask monitor APIs.
type MonitorStats struct {
	FramesProcessed int     `json:"frames_processed"`
	CurrentFPS      float64 `json:"current_fps"`
	DetectionCount  int     `json:"detection_count"`
	TargetFPS       int     `json:"target_fps"`
}

// SharedMemoryStats mirrors the JSON shape used by the Flask monitor APIs.
type SharedMemoryStats struct {
	FrameCount         int `json:"frame_count"`
	TotalFramesWritten int `json:"total_frames_written"`
	DetectionVersion   int `json:"detection_version"`
	HasDetection       int `json:"has_detection"`
}
