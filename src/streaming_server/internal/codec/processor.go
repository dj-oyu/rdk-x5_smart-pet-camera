package codec

import (
	"bytes"
	"fmt"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/types"
)

// NAL unit start codes
var (
	startCode3 = []byte{0x00, 0x00, 0x01}
	startCode4 = []byte{0x00, 0x00, 0x00, 0x01}
)

// Processor handles H.265 NAL unit processing
type Processor struct {
	vpsCache   []byte // Cached VPS NAL unit
	spsCache   []byte // Cached SPS NAL unit
	ppsCache   []byte // Cached PPS NAL unit
	hasHeaders bool   // True if VPS/SPS/PPS are cached
}

// NewProcessor creates a new H.265 NAL processor
func NewProcessor() *Processor {
	return &Processor{
		hasHeaders: false,
	}
}

// extractNALType extracts the H.265 NAL unit type from the byte after start code.
// H.265 NAL header is 2 bytes: (nalType << 1) in first byte.
func extractNALType(headerByte byte) uint8 {
	return (headerByte >> 1) & 0x3F
}

// Process processes a raw H.265 frame and extracts/caches headers
// Optimized: only copies data for VPS/SPS/PPS (rare), avoids allocation for trail frames
func (p *Processor) Process(frame *types.VideoFrame) error {
	data := frame.Data
	if len(data) == 0 {
		return nil
	}

	offset := 0
	for offset < len(data) {
		// BCE-friendly start code detection: bytes.Equal with a single slice creation
		// per branch reduces per-byte IsInBounds hits to one IsSliceInBounds each.
		// Guard (e.g. offset+4 <= len(data)) BCE-proves the slice creation itself
		// when the compiler can derive offset >= 0 from invariant.
		startCodeLen := 0
		if offset+4 <= len(data) && bytes.Equal(data[offset:offset+4], startCode4) {
			startCodeLen = 4
		} else if offset+3 <= len(data) && bytes.Equal(data[offset:offset+3], startCode3) {
			startCodeLen = 3
		} else {
			offset++
			continue
		}

		nalStart := offset
		nalHeaderOffset := offset + startCodeLen
		if nalHeaderOffset >= len(data) {
			break
		}

		nalType := extractNALType(data[nalHeaderOffset])

		// Find next start code to determine NAL end
		nextStart := p.findNextStartCode(data, nalHeaderOffset+1)
		nalEnd := nextStart
		if nalEnd == -1 {
			nalEnd = len(data)
		}

		// Only copy for VPS/SPS/PPS (rare - typically once per GOP)
		switch nalType {
		case types.NALTypeH265VPS:
			p.vpsCache = append([]byte(nil), data[nalStart:nalEnd]...)
		case types.NALTypeH265SPS:
			p.spsCache = append([]byte(nil), data[nalStart:nalEnd]...)
		case types.NALTypeH265PPS:
			p.ppsCache = append([]byte(nil), data[nalStart:nalEnd]...)
			if len(p.vpsCache) > 0 && len(p.spsCache) > 0 {
				p.hasHeaders = true
			}
		case types.NALTypeH265IDRWRADL, types.NALTypeH265IDRNLP:
			frame.IsIDR = true
		}

		offset = nalEnd
	}

	return nil
}

// containsIDR scans raw H.265 data and returns true if any NAL unit is an IDR.
// Zero-allocation: avoids the full parseNALUnits copy path used only to check
// for IDR presence. Called only from PrependHeaders (cold path, IDR frames).
func (p *Processor) containsIDR(data []byte) bool {
	offset := 0
	for offset < len(data) {
		startCodeLen := 0
		if offset+4 <= len(data) && bytes.Equal(data[offset:offset+4], startCode4) {
			startCodeLen = 4
		} else if offset+3 <= len(data) && bytes.Equal(data[offset:offset+3], startCode3) {
			startCodeLen = 3
		} else {
			offset++
			continue
		}
		hdrOff := offset + startCodeLen
		if hdrOff >= len(data) {
			break
		}
		t := extractNALType(data[hdrOff])
		if t == types.NALTypeH265IDRWRADL || t == types.NALTypeH265IDRNLP {
			return true
		}
		next := p.findNextStartCode(data, hdrOff+1)
		if next == -1 {
			break
		}
		offset = next
	}
	return false
}

// PrependHeaders prepends VPS/SPS/PPS headers to IDR frames
// This is necessary for recording mid-stream
func (p *Processor) PrependHeaders(data []byte) ([]byte, error) {
	if !p.hasHeaders {
		return data, nil // No headers to prepend
	}

	// Use zero-alloc IDR scan instead of full parseNALUnits to avoid
	// O(NAL count) allocations just for presence detection.
	if !p.containsIDR(data) {
		return data, nil // Not an IDR frame, no need to prepend
	}

	// Prepend VPS, SPS, and PPS to the frame data
	result := make([]byte, 0, len(p.vpsCache)+len(p.spsCache)+len(p.ppsCache)+len(data))
	result = append(result, p.vpsCache...)
	result = append(result, p.spsCache...)
	result = append(result, p.ppsCache...)
	result = append(result, data...)

	return result, nil
}

// HasHeaders returns true if VPS/SPS/PPS headers are cached
func (p *Processor) HasHeaders() bool {
	return p.hasHeaders
}

// GetVPS returns the cached VPS NAL unit
func (p *Processor) GetVPS() []byte {
	return p.vpsCache
}

// GetSPS returns the cached SPS NAL unit
func (p *Processor) GetSPS() []byte {
	return p.spsCache
}

// GetPPS returns the cached PPS NAL unit
func (p *Processor) GetPPS() []byte {
	return p.ppsCache
}

// parseNALUnits parses raw H.265 data into NAL units
func (p *Processor) parseNALUnits(data []byte) ([]types.NALUnit, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("empty data")
	}

	nalUnits := make([]types.NALUnit, 0, 8)
	offset := 0

	for offset < len(data) {
		// Find next start code
		startCodeLen := 0
		if offset+3 <= len(data) && bytes.Equal(data[offset:offset+3], startCode3) {
			startCodeLen = 3
		} else if offset+4 <= len(data) && bytes.Equal(data[offset:offset+4], startCode4) {
			startCodeLen = 4
		} else {
			offset++
			continue
		}

		// Find end of this NAL unit (next start code or end of data)
		nalStart := offset
		offset += startCodeLen

		if offset >= len(data) {
			break
		}

		nalHeaderByte := data[offset]

		// Find next start code
		nextStart := p.findNextStartCode(data, offset+1)
		nalEnd := nextStart
		if nalEnd == -1 {
			nalEnd = len(data)
		}

		// Extract NAL unit (including start code)
		nalData := make([]byte, nalEnd-nalStart)
		copy(nalData, data[nalStart:nalEnd])

		nalUnits = append(nalUnits, types.NALUnit{
			Type: nalHeaderByte, // Store raw header byte; caller uses extractNALType()
			Data: nalData,
		})

		offset = nalEnd
	}

	return nalUnits, nil
}

// findNextStartCode finds the next start code (0x000001 or 0x00000001) at or
// after offset.
//
// Implementation uses bytes.Index which leverages NEON SIMD on ARM64 for a
// ~10x speedup over per-byte scanning on typical H.265 frame sizes (>1KB).
//
// Algorithm: search for the 3-byte suffix [0x00, 0x00, 0x01] common to both
// start code lengths, then check if the preceding byte is 0x00 to detect the
// 4-byte form and back up by one.
func (p *Processor) findNextStartCode(data []byte, offset int) int {
	if offset >= len(data) {
		return -1
	}
	sub := data[offset:]
	i := bytes.Index(sub, startCode3)
	if i < 0 {
		return -1
	}
	// If the byte before the [0x00, 0x00, 0x01] is also 0x00, the start code
	// is actually the 4-byte form beginning one position earlier.
	if i > 0 && sub[i-1] == 0x00 {
		return offset + i - 1
	}
	return offset + i
}

// ExtractNALType extracts the H.265 NAL unit type from raw data
func ExtractNALType(data []byte) uint8 {
	// Fixed-origin slices (data[0:k]) with len guard are BCE'd by the prove pass.
	if len(data) >= 5 && bytes.Equal(data[0:4], startCode4) {
		return extractNALType(data[4])
	}
	if len(data) >= 4 && bytes.Equal(data[0:3], startCode3) {
		return extractNALType(data[3])
	}
	return 0
}

// IsIDRFrame checks if data contains an H.265 IDR frame
func IsIDRFrame(data []byte) bool {
	nalType := ExtractNALType(data)
	return nalType == types.NALTypeH265IDRWRADL || nalType == types.NALTypeH265IDRNLP
}
