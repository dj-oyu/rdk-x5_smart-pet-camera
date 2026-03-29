package codec

import (
	"bytes"
	"testing"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/types"
)

// H.265 NAL header byte = (nalType << 1). Second byte of NAL header is always 0x01.
func nalHeader(nalType uint8) byte { return nalType << 1 }

// buildFrame constructs raw H.265 data with 4-byte start codes.
// Each entry is (nalType, payloadLen).
func buildFrame(nals ...struct {
	t   uint8
	len int
}) []byte {
	var buf []byte
	for _, n := range nals {
		buf = append(buf, 0x00, 0x00, 0x00, 0x01) // 4-byte start code
		buf = append(buf, nalHeader(n.t), 0x01)   // 2-byte NAL header
		for i := 0; i < n.len; i++ {
			// payload: avoid creating accidental start codes (no 0x00 0x00 sequences)
			buf = append(buf, byte(0x80+(i%64)))
		}
	}
	return buf
}

// buildFrame3 uses 3-byte start codes.
func buildFrame3(nals ...struct {
	t   uint8
	len int
}) []byte {
	var buf []byte
	for _, n := range nals {
		buf = append(buf, 0x00, 0x00, 0x01)     // 3-byte start code
		buf = append(buf, nalHeader(n.t), 0x01) // 2-byte NAL header
		for i := 0; i < n.len; i++ {
			buf = append(buf, byte(0x80+(i%64)))
		}
	}
	return buf
}

// --- Unit tests ---

func TestProcessEmpty(t *testing.T) {
	p := NewProcessor()
	frame := &types.VideoFrame{Data: []byte{}}
	if err := p.Process(frame); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.HasHeaders() {
		t.Fatal("should not have headers on empty input")
	}
}

func TestProcessTrail(t *testing.T) {
	p := NewProcessor()
	data := buildFrame(
		struct {
			t   uint8
			len int
		}{types.NALTypeH265TrailR, 100},
	)
	frame := &types.VideoFrame{Data: data}
	if err := p.Process(frame); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if frame.IsIDR {
		t.Fatal("trail frame must not be flagged as IDR")
	}
	if p.HasHeaders() {
		t.Fatal("trail frame should not populate header cache")
	}
}

func TestProcessIDR(t *testing.T) {
	p := NewProcessor()

	// First feed VPS+SPS+PPS to warm the cache.
	headers := buildFrame(
		struct {
			t   uint8
			len int
		}{types.NALTypeH265VPS, 10},
		struct {
			t   uint8
			len int
		}{types.NALTypeH265SPS, 20},
		struct {
			t   uint8
			len int
		}{types.NALTypeH265PPS, 8},
	)
	frameH := &types.VideoFrame{Data: headers}
	if err := p.Process(frameH); err != nil {
		t.Fatalf("header process error: %v", err)
	}
	if !p.HasHeaders() {
		t.Fatal("expected headers to be cached after VPS+SPS+PPS")
	}

	// Now process an IDR frame.
	idrData := buildFrame(
		struct {
			t   uint8
			len int
		}{types.NALTypeH265IDRWRADL, 200},
	)
	frameIDR := &types.VideoFrame{Data: idrData}
	if err := p.Process(frameIDR); err != nil {
		t.Fatalf("IDR process error: %v", err)
	}
	if !frameIDR.IsIDR {
		t.Fatal("IDR frame must be flagged as IDR")
	}
}

func TestProcessIDRNLP(t *testing.T) {
	p := NewProcessor()
	data := buildFrame(
		struct {
			t   uint8
			len int
		}{types.NALTypeH265IDRNLP, 50},
	)
	frame := &types.VideoFrame{Data: data}
	if err := p.Process(frame); err != nil {
		t.Fatal(err)
	}
	if !frame.IsIDR {
		t.Fatal("IDR_NLP frame must be flagged as IDR")
	}
}

func TestProcess3ByteStartCode(t *testing.T) {
	p := NewProcessor()
	data := buildFrame3(
		struct {
			t   uint8
			len int
		}{types.NALTypeH265TrailR, 50},
	)
	frame := &types.VideoFrame{Data: data}
	if err := p.Process(frame); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFindNextStartCode(t *testing.T) {
	cases := []struct {
		name   string
		data   []byte
		offset int
		want   int
	}{
		{"empty", []byte{}, 0, -1},
		{"too short", []byte{0x00, 0x00}, 0, -1},
		{"3-byte at start", []byte{0x00, 0x00, 0x01, 0xAA}, 0, 0},
		{"4-byte at start", []byte{0x00, 0x00, 0x00, 0x01, 0xAA}, 0, 0},
		{"3-byte after offset", []byte{0xFF, 0xFF, 0x00, 0x00, 0x01, 0xAA}, 0, 2},
		{"4-byte after offset", []byte{0xFF, 0xFF, 0x00, 0x00, 0x00, 0x01, 0xAA}, 0, 2},
		{"offset past start", []byte{0x00, 0x00, 0x01, 0xFF, 0x00, 0x00, 0x01}, 1, 4},
		{"no start code", []byte{0xFF, 0xFE, 0xFD, 0xFC}, 0, -1},
		{"3-byte at end", []byte{0xFF, 0x00, 0x00, 0x01}, 0, 1},
		// Overlap: 4-byte start code at 0, then payload 0xAA (non-zero), then 4-byte at 5.
		// Searching from offset=5 should find the second start code at 5.
		{"4-byte 4-byte, skip first",
			[]byte{0x00, 0x00, 0x00, 0x01, 0xAA, 0x00, 0x00, 0x00, 0x01, 0xBB}, 5, 5},
		// Two start codes with non-zero gap; search from 0 should return the first.
		{"4-byte first of two", []byte{0x00, 0x00, 0x00, 0x01, 0xAA, 0xBB, 0x00, 0x00, 0x01, 0xCC}, 0, 0},
	}
	p := NewProcessor()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := p.findNextStartCode(c.data, c.offset)
			if got != c.want {
				t.Errorf("findNextStartCode(%v, %d) = %d, want %d", c.data, c.offset, got, c.want)
			}
		})
	}
}

func TestExtractNALType(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want uint8
	}{
		{"4-byte VPS", append([]byte{0x00, 0x00, 0x00, 0x01}, nalHeader(types.NALTypeH265VPS), 0x01), types.NALTypeH265VPS},
		{"4-byte SPS", append([]byte{0x00, 0x00, 0x00, 0x01}, nalHeader(types.NALTypeH265SPS), 0x01), types.NALTypeH265SPS},
		{"3-byte IDR", append([]byte{0x00, 0x00, 0x01}, nalHeader(types.NALTypeH265IDRWRADL), 0x01), types.NALTypeH265IDRWRADL},
		{"empty", []byte{}, 0},
		{"too short", []byte{0x00, 0x00}, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ExtractNALType(c.data)
			if got != c.want {
				t.Errorf("ExtractNALType = %d, want %d", got, c.want)
			}
		})
	}
}

func TestPrependHeaders(t *testing.T) {
	p := NewProcessor()

	// Without headers: data returned as-is.
	plain := []byte{0x01, 0x02, 0x03}
	got, err := p.PrependHeaders(plain)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("PrependHeaders without headers: got %v err %v", got, err)
	}

	// Populate cache.
	headers := buildFrame(
		struct {
			t   uint8
			len int
		}{types.NALTypeH265VPS, 4},
		struct {
			t   uint8
			len int
		}{types.NALTypeH265SPS, 4},
		struct {
			t   uint8
			len int
		}{types.NALTypeH265PPS, 4},
	)
	p.Process(&types.VideoFrame{Data: headers})
	if !p.HasHeaders() {
		t.Fatal("expected headers after processing")
	}

	// Trail frame: returned as-is (no IDR).
	trail := buildFrame(struct {
		t   uint8
		len int
	}{types.NALTypeH265TrailR, 20})
	got, err = p.PrependHeaders(trail)
	if err != nil || !bytes.Equal(got, trail) {
		t.Fatalf("PrependHeaders on trail: expected passthrough, got len=%d err=%v", len(got), err)
	}

	// IDR frame: headers prepended.
	idr := buildFrame(struct {
		t   uint8
		len int
	}{types.NALTypeH265IDRWRADL, 20})
	got, err = p.PrependHeaders(idr)
	if err != nil {
		t.Fatalf("PrependHeaders IDR error: %v", err)
	}
	if len(got) <= len(idr) {
		t.Fatalf("PrependHeaders IDR: output (%d) not longer than input (%d)", len(got), len(idr))
	}
	// Output must start with VPS start code.
	if !bytes.HasPrefix(got, []byte{0x00, 0x00, 0x00, 0x01}) {
		t.Fatal("PrependHeaders IDR: output does not start with start code")
	}
	// Output must end with the original IDR data.
	if !bytes.HasSuffix(got, idr) {
		t.Fatal("PrependHeaders IDR: output does not end with original IDR data")
	}
}

// --- Benchmarks ---

// makeLargeTrailFrame builds a realistic trail frame with no VPS/SPS/PPS.
// Payload is 0x80+ bytes to avoid accidental start codes.
func makeLargeTrailFrame(size int) []byte {
	data := buildFrame(struct {
		t   uint8
		len int
	}{types.NALTypeH265TrailR, size})
	return data
}

// makeIDRFrameWithHeaders builds a frame containing VPS+SPS+PPS+IDR NALs.
func makeIDRFrameWithHeaders() []byte {
	return buildFrame(
		struct {
			t   uint8
			len int
		}{types.NALTypeH265VPS, 16},
		struct {
			t   uint8
			len int
		}{types.NALTypeH265SPS, 64},
		struct {
			t   uint8
			len int
		}{types.NALTypeH265PPS, 16},
		struct {
			t   uint8
			len int
		}{types.NALTypeH265IDRWRADL, 400},
	)
}

func BenchmarkProcessTrail(b *testing.B) {
	p := NewProcessor()
	data := makeLargeTrailFrame(50_000)
	frame := &types.VideoFrame{Data: data}
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		frame.IsIDR = false
		_ = p.Process(frame)
	}
}

func BenchmarkProcessIDR(b *testing.B) {
	p := NewProcessor()
	data := makeIDRFrameWithHeaders()
	frame := &types.VideoFrame{Data: data}
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		frame.IsIDR = false
		_ = p.Process(frame)
	}
}

func BenchmarkFindNextStartCode(b *testing.B) {
	p := NewProcessor()
	// 100KB of payload with a single start code near the end.
	data := make([]byte, 100_000)
	for i := range data {
		data[i] = 0x80
	}
	// Embed a 4-byte start code at position 99990.
	data[99990] = 0x00
	data[99991] = 0x00
	data[99992] = 0x00
	data[99993] = 0x01
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = p.findNextStartCode(data, 0)
	}
}

func BenchmarkPrependHeaders(b *testing.B) {
	p := NewProcessor()
	// Warm the cache.
	p.Process(&types.VideoFrame{Data: makeIDRFrameWithHeaders()})

	idr := buildFrame(struct {
		t   uint8
		len int
	}{types.NALTypeH265IDRWRADL, 200_000})
	b.SetBytes(int64(len(idr)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = p.PrependHeaders(idr)
	}
}

func BenchmarkExtractNALType(b *testing.B) {
	data := append([]byte{0x00, 0x00, 0x00, 0x01}, nalHeader(types.NALTypeH265IDRWRADL), 0x01)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = ExtractNALType(data)
	}
}
