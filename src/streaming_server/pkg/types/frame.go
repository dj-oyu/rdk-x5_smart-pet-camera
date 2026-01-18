package types

import "time"

// H264Frame represents a complete H.264 frame with metadata
type H264Frame struct {
	Data      []byte    // Raw H.264 data (NAL units)
	Timestamp time.Time // Frame capture timestamp
	FrameNum  uint64    // Sequential frame number
	IsIDR     bool      // True if this frame contains an IDR
	Width     int       // Frame width
	Height    int       // Frame height
}

// NALUnit represents a single H.264 NAL unit
type NALUnit struct {
	Type uint8  // NAL unit type (lower 5 bits)
	Data []byte // Complete NAL unit including header
}

// NALUnitType constants
const (
	NALTypeSlice    uint8 = 1
	NALTypeIDR      uint8 = 5
	NALTypeSEI      uint8 = 6
	NALTypeSPS      uint8 = 7
	NALTypePPS      uint8 = 8
	NALTypeAUD      uint8 = 9
	NALTypeEndSeq   uint8 = 10
	NALTypeEndStream uint8 = 11
	NALTypeFiller   uint8 = 12
)

// StreamConfig holds configuration for the streaming server
type StreamConfig struct {
	ShmName     string // Shared memory name (e.g., "/spc_camera_shm")
	ShmSize     int    // Shared memory size in bytes
	MaxClients  int    // Maximum WebRTC clients
	RecordPath  string // Base path for recordings
	MetricsAddr string // Prometheus metrics address (e.g., ":9090")
	ProfileAddr string // pprof profiling address (e.g., ":6060")
}
