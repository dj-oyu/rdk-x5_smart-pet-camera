package h264

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

// Processor handles H.264 NAL unit processing
type Processor struct {
	spsCache   []byte // Cached SPS NAL unit
	ppsCache   []byte // Cached PPS NAL unit
	hasHeaders bool   // True if SPS/PPS are cached
}

// NewProcessor creates a new H.264 processor
func NewProcessor() *Processor {
	return &Processor{
		hasHeaders: false,
	}
}

// Process processes a raw H.264 frame and extracts/caches headers
// Optimized: only copies data for SPS/PPS (rare), avoids allocation for P-frames
func (p *Processor) Process(frame *types.H264Frame) error {
	data := frame.Data
	if len(data) == 0 {
		return nil
	}

	offset := 0
	for offset < len(data) {
		// Find start code
		startCodeLen := 0
		if offset+4 <= len(data) && data[offset] == 0 && data[offset+1] == 0 && data[offset+2] == 0 && data[offset+3] == 1 {
			startCodeLen = 4
		} else if offset+3 <= len(data) && data[offset] == 0 && data[offset+1] == 0 && data[offset+2] == 1 {
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

		nalType := data[nalHeaderOffset] & 0x1F

		// Find next start code to determine NAL end
		nextStart := p.findNextStartCode(data, nalHeaderOffset+1)
		nalEnd := nextStart
		if nalEnd == -1 {
			nalEnd = len(data)
		}

		// Only copy for SPS/PPS (rare - typically once per GOP)
		switch nalType {
		case types.NALTypeSPS:
			p.spsCache = append([]byte(nil), data[nalStart:nalEnd]...)
		case types.NALTypePPS:
			p.ppsCache = append([]byte(nil), data[nalStart:nalEnd]...)
			if len(p.spsCache) > 0 {
				p.hasHeaders = true
			}
		case types.NALTypeIDR:
			frame.IsIDR = true
		}

		offset = nalEnd
	}

	return nil
}

// PrependHeaders prepends SPS/PPS headers to IDR frames
// This is necessary for recording mid-stream
func (p *Processor) PrependHeaders(data []byte) ([]byte, error) {
	if !p.hasHeaders {
		return data, nil // No headers to prepend
	}

	// Check if this frame starts with IDR
	nalUnits, err := p.parseNALUnits(data)
	if err != nil {
		return data, nil
	}

	hasIDR := false
	for _, nal := range nalUnits {
		if (nal.Type & 0x1F) == types.NALTypeIDR {
			hasIDR = true
			break
		}
	}

	if !hasIDR {
		return data, nil // Not an IDR frame, no need to prepend
	}

	// Prepend SPS and PPS to the frame data
	result := make([]byte, 0, len(p.spsCache)+len(p.ppsCache)+len(data))
	result = append(result, p.spsCache...)
	result = append(result, p.ppsCache...)
	result = append(result, data...)

	return result, nil
}

// HasHeaders returns true if SPS/PPS headers are cached
func (p *Processor) HasHeaders() bool {
	return p.hasHeaders
}

// GetSPS returns the cached SPS NAL unit
func (p *Processor) GetSPS() []byte {
	return p.spsCache
}

// GetPPS returns the cached PPS NAL unit
func (p *Processor) GetPPS() []byte {
	return p.ppsCache
}

// parseNALUnits parses raw H.264 data into NAL units
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
		nalType := nalHeaderByte & 0x1F

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
			Type: nalType,
			Data: nalData,
		})

		offset = nalEnd
	}

	return nalUnits, nil
}

// findNextStartCode finds the next start code position
func (p *Processor) findNextStartCode(data []byte, offset int) int {
	for i := offset; i < len(data)-2; i++ {
		if data[i] == 0x00 && data[i+1] == 0x00 {
			if i+2 < len(data) && data[i+2] == 0x01 {
				return i // Found 0x000001
			}
			if i+3 < len(data) && data[i+2] == 0x00 && data[i+3] == 0x01 {
				return i // Found 0x00000001
			}
		}
	}
	return -1 // No start code found
}

// ExtractNALType extracts the NAL unit type from raw data
func ExtractNALType(data []byte) uint8 {
	// Find first NAL header byte after start code
	if len(data) >= 4 && bytes.Equal(data[0:4], startCode4) {
		return data[4] & 0x1F
	}
	if len(data) >= 3 && bytes.Equal(data[0:3], startCode3) {
		return data[3] & 0x1F
	}
	return 0
}

// IsIDRFrame checks if data contains an IDR frame
func IsIDRFrame(data []byte) bool {
	nalType := ExtractNALType(data)
	return nalType == types.NALTypeIDR
}
