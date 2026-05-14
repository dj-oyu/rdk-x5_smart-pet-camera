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
	FmtpLine    string // raw "a=fmtp:<pt> ..." line for H.265, echoed back in answer
	Candidates  []OfferCandidate
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

	// Capture the H.265 fmtp line so we can echo it in the answer.
	// Browsers (Chrome ≥107, Safari) require profile-id/level-id/tier-flag
	// in the fmtp; an answer without these fails setRemoteDescription
	// silently and ICE never starts.
	fmtpPrefix := fmt.Sprintf("a=fmtp:%d ", offer.PayloadType)
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, fmtpPrefix) {
			offer.FmtpLine = line
			break
		}
	}

	offer.Candidates = parseOfferCandidates(sdp)

	return offer, nil
}

// AnswerParams holds local parameters for generating an SDP answer.
type AnswerParams struct {
	ICEUfrag        string
	ICEPwd          string
	DTLSFingerprint string   // "XX:XX:XX:..." sha-256 hex
	CandidateIPs    []net.IP // one ICE host candidate per address
	CandidatePort   int
	PayloadType     int
	MID             string
	FmtpLine        string // raw "a=fmtp:<pt> ..." copied from the offer
	SSRC            uint32 // SSRC the server will send video on
	StreamID        string // msid stream identifier (e.g. "pet-camera")
	TrackID         string // msid track identifier (e.g. "video0")
	CNAME           string // RTCP CNAME for the SSRC
	// ICEFull turns off the "a=ice-lite" attribute so the server acts as a
	// full ICE agent that originates connectivity checks. Default false
	// retains the long-standing ICE-lite passive behaviour.
	ICEFull bool
}

// GenerateAnswer creates an SDP answer string for send-only H.265 video.
func GenerateAnswer(p *AnswerParams) string {
	sessID := randomSessionID()
	if len(p.CandidateIPs) == 0 {
		p.CandidateIPs = []net.IP{net.IPv4(127, 0, 0, 1)}
	}
	primary := p.CandidateIPs[0]
	primaryIP := primary.String()
	// SDP RFC 4566: "c=IN <addrtype> ..." selects the address family of
	// the *default* address — must match `primary`. The actual per-pair
	// candidates each carry their own IP, so this only affects what a
	// non-ICE peer would do; modern browsers honour candidates first.
	connAddrType := "IP4"
	if primary.To4() == nil {
		connAddrType = "IP6"
	}

	streamID := p.StreamID
	if streamID == "" {
		streamID = "pet-camera"
	}
	trackID := p.TrackID
	if trackID == "" {
		trackID = "video0"
	}
	cname := p.CNAME
	if cname == "" {
		cname = "pet-camera"
	}

	var sb strings.Builder
	sb.WriteString("v=0\r\n")
	sb.WriteString(fmt.Sprintf("o=- %s 2 IN IP4 127.0.0.1\r\n", sessID))
	sb.WriteString("s=-\r\n")
	sb.WriteString("t=0 0\r\n")
	sb.WriteString(fmt.Sprintf("a=group:BUNDLE %s\r\n", p.MID))
	sb.WriteString(fmt.Sprintf("a=msid-semantic: WMS %s\r\n", streamID))

	// Media section. The c=/a=rtcp= lines are session defaults overridden
	// by individual ICE candidates, so the first IP is fine.
	sb.WriteString(fmt.Sprintf("m=video %d UDP/TLS/RTP/SAVPF %d\r\n", p.CandidatePort, p.PayloadType))
	sb.WriteString(fmt.Sprintf("c=IN %s %s\r\n", connAddrType, primaryIP))
	sb.WriteString(fmt.Sprintf("a=rtcp:%d IN %s %s\r\n", p.CandidatePort, connAddrType, primaryIP))

	// ICE
	sb.WriteString(fmt.Sprintf("a=ice-ufrag:%s\r\n", p.ICEUfrag))
	sb.WriteString(fmt.Sprintf("a=ice-pwd:%s\r\n", p.ICEPwd))
	if !p.ICEFull {
		sb.WriteString("a=ice-lite\r\n")
	}
	sb.WriteString("a=ice-options:trickle\r\n")

	// DTLS
	sb.WriteString(fmt.Sprintf("a=fingerprint:sha-256 %s\r\n", p.DTLSFingerprint))
	sb.WriteString("a=setup:passive\r\n") // server is DTLS server (passive)

	sb.WriteString(fmt.Sprintf("a=mid:%s\r\n", p.MID))
	// msid associates the track with a MediaStream — Safari rejects sendonly
	// answers that omit it and never starts ICE.
	sb.WriteString(fmt.Sprintf("a=msid:%s %s\r\n", streamID, trackID))
	sb.WriteString("a=sendonly\r\n")
	sb.WriteString("a=rtcp-mux\r\n")
	sb.WriteString("a=rtcp-rsize\r\n")

	// Codec
	sb.WriteString(fmt.Sprintf("a=rtpmap:%d H265/90000\r\n", p.PayloadType))
	if p.FmtpLine != "" {
		sb.WriteString(p.FmtpLine + "\r\n")
	}

	// SSRC declarations are required by Safari and recent Chrome to map the
	// incoming RTP stream to the receiver track.
	if p.SSRC != 0 {
		sb.WriteString(fmt.Sprintf("a=ssrc:%d cname:%s\r\n", p.SSRC, cname))
		sb.WriteString(fmt.Sprintf("a=ssrc:%d msid:%s %s\r\n", p.SSRC, streamID, trackID))
	}

	// One host candidate per local interface. Distinct foundation per
	// RFC 8445; priority decreases with the index so the browser has a
	// stable preference order.
	const basePriority = 2130706431 // 126*2^24 + 65535*2^8 + 255
	for i, ip := range p.CandidateIPs {
		sb.WriteString(fmt.Sprintf("a=candidate:%d 1 udp %d %s %d typ host\r\n",
			i+1, basePriority-i, ip.String(), p.CandidatePort))
	}
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
