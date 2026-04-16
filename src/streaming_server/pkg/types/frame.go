package types

import "time"

// VideoFrame represents a complete video frame with metadata
type VideoFrame struct {
	Data        []byte     // Raw video data (NAL units)
	Timestamp   time.Time  // Frame capture timestamp
	FrameNumber uint64     // Sequential frame number
	IsIDR       bool       // True if this frame contains an IDR
	Width       int        // Frame width
	Height      int        // Frame height
	NALUs       []NALBound // NAL unit boundaries (set by Processor.Process)
}

// NALBound describes the location of a NAL unit within VideoFrame.Data.
// Offset points to the first byte of the NAL header (after the start code).
type NALBound struct {
	Offset int   // Byte offset in Data (start of NAL header, after start code)
	Length int   // NAL unit length (including 2-byte header)
	Type   uint8 // H.265 NAL unit type
}

// NALUnit represents a single NAL unit
type NALUnit struct {
	Type uint8  // NAL unit type
	Data []byte // Complete NAL unit including header
}

// H.264 NAL unit type constants
const (
	NALTypeSlice     uint8 = 1
	NALTypeIDR       uint8 = 5
	NALTypeSEI       uint8 = 6
	NALTypeSPS       uint8 = 7
	NALTypePPS       uint8 = 8
	NALTypeAUD       uint8 = 9
	NALTypeEndSeq    uint8 = 10
	NALTypeEndStream uint8 = 11
	NALTypeFiller    uint8 = 12
)

// H.265 (HEVC) NAL unit type constants
// NAL type = (first_byte >> 1) & 0x3F
const (
	NALTypeH265TrailN   uint8 = 0
	NALTypeH265TrailR   uint8 = 1
	NALTypeH265IDRWRADL uint8 = 19
	NALTypeH265IDRNLP   uint8 = 20
	NALTypeH265VPS      uint8 = 32
	NALTypeH265SPS      uint8 = 33
	NALTypeH265PPS      uint8 = 34
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
