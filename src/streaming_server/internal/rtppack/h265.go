// Package rtppack provides H.265 RTP packetization without pion/rtp dependency.
package rtppack

import (
	"encoding/binary"

	"github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server/pkg/types"
)

const (
	rtpHeaderSize    = 12
	h265NALHeaderLen = 2
	fuHeaderLen      = 3 // PayloadHdr(2) + FU(1)
	h265TypeFU       = 49
)

// PacketizeH265 converts a processed VideoFrame into RTP packets.
// Each returned []byte is a complete RTP packet (header + payload).
// Small NALUs produce single-NALU packets; large NALUs are FU-A fragmented.
//
// The caller must increment seq for each returned packet.
// Returns the number of packets produced and the next sequence number.
func PacketizeH265(frame *types.VideoFrame, ssrc uint32, startSeq uint16, ts uint32, mtu int) (packets [][]byte, nextSeq uint16) {
	seq := startSeq
	maxPayload := mtu - rtpHeaderSize

	for _, nalu := range frame.NALUs {
		naluData := frame.Data[nalu.Offset : nalu.Offset+nalu.Length]

		if len(naluData) <= maxPayload {
			// Single NALU packet
			pkt := make([]byte, rtpHeaderSize+len(naluData))
			writeRTPHeader(pkt, seq, ts, ssrc, false)
			copy(pkt[rtpHeaderSize:], naluData)
			packets = append(packets, pkt)
			seq++
		} else {
			// FU-A fragmentation
			packets, seq = fragmentFU(packets, naluData, seq, ts, ssrc, maxPayload)
		}
	}

	// Set marker bit on the last packet (end of access unit)
	if len(packets) > 0 {
		packets[len(packets)-1][1] |= 0x80 // Marker bit
	}

	return packets, seq
}

// fragmentFU splits a large NALU into FU-A packets.
func fragmentFU(packets [][]byte, nalu []byte, seq uint16, ts uint32, ssrc uint32, maxPayload int) ([][]byte, uint16) {
	// H.265 NAL header: 2 bytes
	// FU PayloadHdr: same F/LayerID/TID but Type=49
	payloadHdr0 := (nalu[0] & 0x81) | (h265TypeFU << 1) // F, LayerID; Type=49
	payloadHdr1 := nalu[1]                                // TID
	nalType := (nalu[0] >> 1) & 0x3F

	// FU data = NALU data without the 2-byte NAL header
	fuData := nalu[h265NALHeaderLen:]
	maxChunk := maxPayload - fuHeaderLen

	for offset := 0; offset < len(fuData); {
		end := offset + maxChunk
		if end > len(fuData) {
			end = len(fuData)
		}

		isFirst := offset == 0
		isLast := end == len(fuData)

		fuHeader := nalType
		if isFirst {
			fuHeader |= 0x80 // S bit (Start)
		}
		if isLast {
			fuHeader |= 0x40 // E bit (End)
		}

		chunkLen := end - offset
		pkt := make([]byte, rtpHeaderSize+fuHeaderLen+chunkLen)
		writeRTPHeader(pkt, seq, ts, ssrc, false)

		// FU header (3 bytes)
		pkt[rtpHeaderSize] = payloadHdr0
		pkt[rtpHeaderSize+1] = payloadHdr1
		pkt[rtpHeaderSize+2] = fuHeader

		copy(pkt[rtpHeaderSize+fuHeaderLen:], fuData[offset:end])

		packets = append(packets, pkt)
		seq++
		offset = end
	}

	return packets, seq
}

// writeRTPHeader writes a minimal RTP header (V=2, no CSRC, no extensions).
func writeRTPHeader(buf []byte, seq uint16, ts uint32, ssrc uint32, marker bool) {
	buf[0] = 0x80 // V=2
	buf[1] = 96   // PT default — overridden by caller if needed
	if marker {
		buf[1] |= 0x80
	}
	binary.BigEndian.PutUint16(buf[2:4], seq)
	binary.BigEndian.PutUint32(buf[4:8], ts)
	binary.BigEndian.PutUint32(buf[8:12], ssrc)
}
