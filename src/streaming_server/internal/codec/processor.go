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
	dataLen := len(data)
	if dataLen == 0 {
		return nil
	}

	offset := 0
	for offset < dataLen {
		// Find start code
		startCodeLen := 0
		if offset+4 <= dataLen && data[offset] == 0 && data[offset+1] == 0 && data[offset+2] == 0 && data[offset+3] == 1 {
			startCodeLen = 4
		} else if offset+3 <= dataLen && data[offset] == 0 && data[offset+1] == 0 && data[offset+2] == 1 {
			startCodeLen = 3
		} else {
			offset++
			continue
		}

		nalStart := offset
		nalHeaderOffset := offset + startCodeLen
		if nalHeaderOffset >= dataLen {
			break
		}

		nalType := extractNALType(data[nalHeaderOffset])

		// Find next start code to determine NAL end
		nextStart := p.findNextStartCode(data, nalHeaderOffset+1)
		nalEnd := nextStart
		if nalEnd == -1 {
			nalEnd = dataLen
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

// PrependHeaders prepends VPS/SPS/PPS headers to IDR frames
// This is necessary for recording mid-stream
func (p *Processor) PrependHeaders(data []byte) ([]byte, error) {
	if !p.hasHeaders {
		return data, nil // No headers to prepend
	}

	// Check if this frame contains IDR
	nalUnits, err := p.parseNALUnits(data)
	if err != nil {
		return data, nil
	}

	hasIDR := false
	for _, nal := range nalUnits {
		nalType := extractNALType(nal.Type)
		if nalType == types.NALTypeH265IDRWRADL || nalType == types.NALTypeH265IDRNLP {
			hasIDR = true
			break
		}
	}

	if !hasIDR {
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
	dataLen := len(data)
	if dataLen == 0 {
		return nil, fmt.Errorf("empty data")
	}

	nalUnits := make([]types.NALUnit, 0, 8)
	offset := 0

	for offset < dataLen {
		// Find next start code
		startCodeLen := 0
		if offset+3 <= dataLen && bytes.Equal(data[offset:offset+3], startCode3) {
			startCodeLen = 3
		} else if offset+4 <= dataLen && bytes.Equal(data[offset:offset+4], startCode4) {
			startCodeLen = 4
		} else {
			offset++
			continue
		}

		// Find end of this NAL unit (next start code or end of data)
		nalStart := offset
		offset += startCodeLen

		if offset >= dataLen {
			break
		}

		nalHeaderByte := data[offset]

		// Find next start code
		nextStart := p.findNextStartCode(data, offset+1)
		nalEnd := nextStart
		if nalEnd == -1 {
			nalEnd = dataLen
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

// findNextStartCode finds the next start code position
func (p *Processor) findNextStartCode(data []byte, offset int) int {
	limit := len(data)
	for i := offset; i+2 < limit; i++ {
		if data[i] == 0x00 && data[i+1] == 0x00 {
			b2 := data[i+2]
			if b2 == 0x01 {
				return i // Found 0x000001
			}
			if i+3 < limit && b2 == 0x00 && data[i+3] == 0x01 {
				return i // Found 0x00000001
			}
		}
	}
	return -1 // No start code found
}

// ExtractNALType extracts the H.265 NAL unit type from raw data
func ExtractNALType(data []byte) uint8 {
	dataLen := len(data)
	// Find first NAL header byte after start code
	if dataLen >= 5 && bytes.Equal(data[0:4], startCode4) {
		return extractNALType(data[4])
	}
	if dataLen >= 4 && bytes.Equal(data[0:3], startCode3) {
		return extractNALType(data[3])
	}
	return 0
}

// IsIDRFrame checks if data contains an H.265 IDR frame
func IsIDRFrame(data []byte) bool {
	nalType := ExtractNALType(data)
	return nalType == types.NALTypeH265IDRWRADL || nalType == types.NALTypeH265IDRNLP
}
