// Package signal implements minimal WebRTC signaling (SDP, ICE-lite, DTLS)
// for send-only H.265 streaming without pion/webrtc dependency.
package signal

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"net"
	"regexp"
	"strings"
)

// Offer holds parsed fields from the browser's SDP offer.
type Offer struct {
	ICEUfrag    string
	ICEPwd      string
	Fingerprint string // sha-256 fingerprint from DTLS
	Setup       string // "actpass" typically from browser
	MID         string // media ID (e.g., "0" or "video")
	PayloadType int    // dynamic PT for H.265
}

var (
	reICEUfrag    = regexp.MustCompile(`a=ice-ufrag:(\S+)`)
	reICEPwd      = regexp.MustCompile(`a=ice-pwd:(\S+)`)
	reFingerprint = regexp.MustCompile(`a=fingerprint:sha-256\s+(\S+)`)
	reSetup       = regexp.MustCompile(`a=setup:(\S+)`)
	reMID         = regexp.MustCompile(`a=mid:(\S+)`)
	reRtpmap      = regexp.MustCompile(`a=rtpmap:(\d+)\s+H265/90000`)
)

// ParseOffer extracts relevant fields from a browser SDP offer.
func ParseOffer(sdp string) (*Offer, error) {
	offer := &Offer{}

	if m := reICEUfrag.FindStringSubmatch(sdp); len(m) > 1 {
		offer.ICEUfrag = m[1]
	} else {
		return nil, fmt.Errorf("sdp: missing ice-ufrag")
	}

	if m := reICEPwd.FindStringSubmatch(sdp); len(m) > 1 {
		offer.ICEPwd = m[1]
	} else {
		return nil, fmt.Errorf("sdp: missing ice-pwd")
	}

	if m := reFingerprint.FindStringSubmatch(sdp); len(m) > 1 {
		offer.Fingerprint = m[1]
	} else {
		return nil, fmt.Errorf("sdp: missing fingerprint")
	}

	if m := reSetup.FindStringSubmatch(sdp); len(m) > 1 {
		offer.Setup = m[1]
	}

	if m := reMID.FindStringSubmatch(sdp); len(m) > 1 {
		offer.MID = m[1]
	} else {
		offer.MID = "0"
	}

	if m := reRtpmap.FindStringSubmatch(sdp); len(m) > 1 {
		fmt.Sscanf(m[1], "%d", &offer.PayloadType)
	} else {
		offer.PayloadType = 96 // default dynamic PT
	}

	return offer, nil
}

// AnswerParams holds local parameters for generating an SDP answer.
type AnswerParams struct {
	ICEUfrag       string
	ICEPwd         string
	DTLSFingerprint string // "XX:XX:XX:..." sha-256 hex
	CandidateIP    net.IP
	CandidatePort  int
	PayloadType    int
	MID            string
}

// GenerateAnswer creates an SDP answer string for send-only H.265 video.
func GenerateAnswer(p *AnswerParams) string {
	sessID := randomSessionID()

	var sb strings.Builder
	sb.WriteString("v=0\r\n")
	sb.WriteString(fmt.Sprintf("o=- %s 2 IN IP4 127.0.0.1\r\n", sessID))
	sb.WriteString("s=-\r\n")
	sb.WriteString("t=0 0\r\n")
	sb.WriteString(fmt.Sprintf("a=group:BUNDLE %s\r\n", p.MID))
	sb.WriteString("a=msid-semantic: WMS\r\n")

	// Media section
	sb.WriteString(fmt.Sprintf("m=video %d UDP/TLS/RTP/SAVPF %d\r\n", p.CandidatePort, p.PayloadType))
	sb.WriteString(fmt.Sprintf("c=IN IP4 %s\r\n", p.CandidateIP.String()))
	sb.WriteString(fmt.Sprintf("a=rtcp:%d IN IP4 %s\r\n", p.CandidatePort, p.CandidateIP.String()))

	// ICE
	sb.WriteString(fmt.Sprintf("a=ice-ufrag:%s\r\n", p.ICEUfrag))
	sb.WriteString(fmt.Sprintf("a=ice-pwd:%s\r\n", p.ICEPwd))
	sb.WriteString("a=ice-lite\r\n")
	sb.WriteString("a=ice-options:trickle\r\n")

	// DTLS
	sb.WriteString(fmt.Sprintf("a=fingerprint:sha-256 %s\r\n", p.DTLSFingerprint))
	sb.WriteString("a=setup:passive\r\n") // server is DTLS server (passive)

	sb.WriteString(fmt.Sprintf("a=mid:%s\r\n", p.MID))
	sb.WriteString("a=sendonly\r\n")
	sb.WriteString("a=rtcp-mux\r\n")
	sb.WriteString("a=rtcp-rsize\r\n")

	// Codec
	sb.WriteString(fmt.Sprintf("a=rtpmap:%d H265/90000\r\n", p.PayloadType))

	// Candidate
	candidateAddr := p.CandidateIP.String()
	sb.WriteString(fmt.Sprintf("a=candidate:1 1 udp 2130706431 %s %d typ host\r\n", candidateAddr, p.CandidatePort))
	sb.WriteString("a=end-of-candidates\r\n")

	return sb.String()
}

// GenerateICECredentials creates random ICE ufrag and pwd.
func GenerateICECredentials() (ufrag, pwd string) {
	ufrag = randomString(4)
	pwd = randomString(22)
	return
}

func randomSessionID() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	return n.String()
}

func randomString(n int) string {
	b := make([]byte, (n+1)/2)
	rand.Read(b)
	return hex.EncodeToString(b)[:n]
}
