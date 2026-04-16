package rtppack

import (
	"encoding/binary"
	"testing"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/types"
)

func TestPacketizeH265_SingleNALU(t *testing.T) {
	// Small NALU that fits in one packet
	frame := &types.VideoFrame{
		Data: []byte{
			// Start code + NAL header (trail_r, type=1) + payload
			0x00, 0x00, 0x00, 0x01, 0x02, 0x01, // NAL header: type=1
			0xAA, 0xBB, 0xCC, 0xDD, // payload
		},
		NALUs: []types.NALBound{
			{Offset: 4, Length: 6, Type: 1},
		},
	}

	packets, nextSeq := PacketizeH265(frame, 0x12345678, 100, 1000, 1200)

	if len(packets) != 1 {
		t.Fatalf("expected 1 packet, got %d", len(packets))
	}
	if nextSeq != 101 {
		t.Errorf("nextSeq: got %d, want 101", nextSeq)
	}

	pkt := packets[0]
	// Check RTP header
	if pkt[0] != 0x80 {
		t.Errorf("V/P/X/CC: got %02x, want 80", pkt[0])
	}
	if pkt[1]&0x7F != 96 {
		t.Errorf("PT: got %d, want 96", pkt[1]&0x7F)
	}
	if pkt[1]&0x80 == 0 {
		t.Error("marker bit not set on last packet")
	}

	seq := binary.BigEndian.Uint16(pkt[2:4])
	if seq != 100 {
		t.Errorf("seq: got %d, want 100", seq)
	}

	ssrc := binary.BigEndian.Uint32(pkt[8:12])
	if ssrc != 0x12345678 {
		t.Errorf("ssrc: got %08x, want 12345678", ssrc)
	}

	// Check payload = raw NALU (without start code)
	payload := pkt[rtpHeaderSize:]
	if len(payload) != 6 {
		t.Errorf("payload len: got %d, want 6", len(payload))
	}
}

func TestPacketizeH265_FUFragmentation(t *testing.T) {
	// Create a NALU larger than MTU
	naluSize := 3000
	data := make([]byte, 4+naluSize) // start code + NALU
	data[0], data[1], data[2], data[3] = 0, 0, 0, 1
	data[4] = 0x02 // type=1 (trail_r) in H.265: (0x02 >> 1) & 0x3F = 1
	data[5] = 0x01 // TID=1

	for i := 6; i < len(data); i++ {
		data[i] = byte(i)
	}

	frame := &types.VideoFrame{
		Data: data,
		NALUs: []types.NALBound{
			{Offset: 4, Length: naluSize, Type: 1},
		},
	}

	mtu := 1200
	packets, _ := PacketizeH265(frame, 0xAABBCCDD, 0, 90000, mtu)

	// Should produce multiple FU packets
	if len(packets) < 2 {
		t.Fatalf("expected multiple FU packets, got %d", len(packets))
	}

	// Each packet should be <= MTU
	for i, pkt := range packets {
		if len(pkt) > mtu {
			t.Errorf("packet %d exceeds MTU: %d > %d", i, len(pkt), mtu)
		}
	}

	// First FU packet: S bit set
	firstFU := packets[0][rtpHeaderSize:]
	fuType := (firstFU[0] >> 1) & 0x3F
	if fuType != h265TypeFU {
		t.Errorf("FU type: got %d, want %d", fuType, h265TypeFU)
	}
	if firstFU[2]&0x80 == 0 {
		t.Error("S bit not set on first FU")
	}
	if firstFU[2]&0x40 != 0 {
		t.Error("E bit should not be set on first FU")
	}

	// Last FU packet: E bit set, marker bit set
	lastPkt := packets[len(packets)-1]
	lastFU := lastPkt[rtpHeaderSize:]
	if lastFU[2]&0x40 == 0 {
		t.Error("E bit not set on last FU")
	}
	if lastPkt[1]&0x80 == 0 {
		t.Error("marker bit not set on last packet")
	}

	// Middle packets: no S or E
	if len(packets) > 2 {
		midFU := packets[1][rtpHeaderSize:]
		if midFU[2]&0xC0 != 0 {
			t.Error("middle FU should have neither S nor E bit")
		}
	}

	// Verify total payload reconstructs the original NALU data (minus NAL header)
	var reconstructed []byte
	for _, pkt := range packets {
		fu := pkt[rtpHeaderSize:]
		reconstructed = append(reconstructed, fu[fuHeaderLen:]...) // skip FU header
	}
	originalPayload := data[6:] // skip start code(4) + NAL header(2)
	if len(reconstructed) != len(originalPayload) {
		t.Errorf("reconstructed len: %d, original: %d", len(reconstructed), len(originalPayload))
	}
}

func TestPacketizeH265_MultipleNALUs(t *testing.T) {
	// VPS + SPS + PPS + IDR — multiple small NALUs
	data := []byte{
		// VPS (type=32)
		0x00, 0x00, 0x00, 0x01, 0x40, 0x01, 0xAA, 0xBB,
		// SPS (type=33)
		0x00, 0x00, 0x00, 0x01, 0x42, 0x01, 0xCC, 0xDD,
		// PPS (type=34)
		0x00, 0x00, 0x00, 0x01, 0x44, 0x01, 0xEE,
	}

	frame := &types.VideoFrame{
		Data: data,
		NALUs: []types.NALBound{
			{Offset: 4, Length: 4, Type: 32},  // VPS
			{Offset: 12, Length: 4, Type: 33}, // SPS
			{Offset: 20, Length: 3, Type: 34}, // PPS
		},
	}

	packets, nextSeq := PacketizeH265(frame, 0, 0, 0, 1200)

	if len(packets) != 3 {
		t.Fatalf("expected 3 packets (one per NALU), got %d", len(packets))
	}
	if nextSeq != 3 {
		t.Errorf("nextSeq: got %d, want 3", nextSeq)
	}

	// Only last packet should have marker bit
	for i, pkt := range packets {
		hasMarker := pkt[1]&0x80 != 0
		if i < len(packets)-1 && hasMarker {
			t.Errorf("packet %d should not have marker bit", i)
		}
		if i == len(packets)-1 && !hasMarker {
			t.Error("last packet should have marker bit")
		}
	}
}
