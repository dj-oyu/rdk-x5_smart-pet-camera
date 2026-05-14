package signal

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// OfferCandidate represents one ICE candidate line parsed from the peer's offer.
// Format (RFC 8839 §5.1): "candidate:<foundation> <component> <proto> <priority> <ip> <port> typ <type> ..."
type OfferCandidate struct {
	Foundation string
	Component  int    // 1=RTP, 2=RTCP (we only use 1, BUNDLE/rtcp-mux)
	Protocol   string // "udp" or "tcp"
	Priority   uint32
	IP         net.IP
	Port       int
	Type       string // "host", "srflx", "prflx", "relay"
}

// parseOfferCandidates extracts all "a=candidate:" lines from the SDP.
// Returns only UDP component=1 candidates (component 2 is unused with rtcp-mux).
// Unparseable lines are skipped silently — defective candidates should not
// block connectivity when valid ones exist alongside.
func parseOfferCandidates(sdp string) []OfferCandidate {
	var out []OfferCandidate
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimRight(line, "\r")
		const prefix = "a=candidate:"
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		body := line[len(prefix):]
		c, err := parseCandidateBody(body)
		if err != nil {
			continue
		}
		if c.Protocol != "udp" || c.Component != 1 {
			continue
		}
		out = append(out, c)
	}
	return out
}

func parseCandidateBody(body string) (OfferCandidate, error) {
	// Minimum 8 tokens: foundation component proto priority ip port "typ" type
	fields := strings.Fields(body)
	if len(fields) < 8 {
		return OfferCandidate{}, fmt.Errorf("candidate: too few fields (%d)", len(fields))
	}
	component, err := strconv.Atoi(fields[1])
	if err != nil {
		return OfferCandidate{}, fmt.Errorf("candidate: bad component: %w", err)
	}
	priority, err := strconv.ParseUint(fields[3], 10, 32)
	if err != nil {
		return OfferCandidate{}, fmt.Errorf("candidate: bad priority: %w", err)
	}
	ip := net.ParseIP(fields[4])
	if ip == nil {
		return OfferCandidate{}, fmt.Errorf("candidate: bad ip %q", fields[4])
	}
	port, err := strconv.Atoi(fields[5])
	if err != nil || port <= 0 || port > 65535 {
		return OfferCandidate{}, fmt.Errorf("candidate: bad port %q", fields[5])
	}
	if fields[6] != "typ" {
		return OfferCandidate{}, fmt.Errorf("candidate: expected 'typ' got %q", fields[6])
	}
	return OfferCandidate{
		Foundation: fields[0],
		Component:  component,
		Protocol:   strings.ToLower(fields[2]),
		Priority:   uint32(priority),
		IP:         ip,
		Port:       port,
		Type:       fields[7],
	}, nil
}

// UDPAddr returns a *net.UDPAddr for sending packets to this candidate.
func (c OfferCandidate) UDPAddr() *net.UDPAddr {
	return &net.UDPAddr{IP: c.IP, Port: c.Port}
}
