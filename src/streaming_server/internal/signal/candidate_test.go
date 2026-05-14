package signal

import (
	"strings"
	"testing"
)

func TestParseOfferCandidates_HostOnly(t *testing.T) {
	sdp := strings.Join([]string{
		"v=0",
		"m=video 9 UDP/TLS/RTP/SAVPF 35",
		"a=candidate:1 1 udp 2113937151 192.168.1.10 50000 typ host",
		"a=candidate:2 1 udp 1677729535 203.0.113.45 60000 typ srflx raddr 192.168.1.10 rport 50000",
		"a=candidate:3 2 udp 2113937150 192.168.1.10 50001 typ host", // RTCP — drop
		"a=candidate:4 1 tcp 1518280447 192.168.1.10 9 typ host tcptype active", // TCP — drop
		"",
	}, "\r\n")

	got := parseOfferCandidates(sdp)
	if len(got) != 2 {
		t.Fatalf("expected 2 UDP component-1 candidates, got %d: %+v", len(got), got)
	}

	if got[0].Foundation != "1" || got[0].Type != CandidateHost || got[0].IP.String() != "192.168.1.10" || got[0].Port != 50000 {
		t.Errorf("first candidate mismatched: %+v", got[0])
	}
	if got[1].Type != CandidateServerReflexive || got[1].IP.String() != "203.0.113.45" || got[1].Port != 60000 {
		t.Errorf("second candidate mismatched: %+v", got[1])
	}
	if got[0].Priority != 2113937151 {
		t.Errorf("priority not parsed: %d", got[0].Priority)
	}
}

func TestParseOfferCandidates_IPv6(t *testing.T) {
	sdp := "a=candidate:1 1 udp 2113939711 2001:db8::1 50000 typ host\r\n"
	got := parseOfferCandidates(sdp)
	if len(got) != 1 {
		t.Fatalf("expected 1, got %d", len(got))
	}
	if got[0].IP.To4() != nil {
		t.Errorf("expected IPv6 address, got IPv4-like %s", got[0].IP)
	}
}

func TestParseOfferCandidates_BadLinesSkipped(t *testing.T) {
	sdp := strings.Join([]string{
		"a=candidate:short fields",
		"a=candidate:1 1 udp notanumber 1.2.3.4 5000 typ host",
		"a=candidate:1 1 udp 100 1.2.3.4 5000 typ host", // valid
		"",
	}, "\r\n")
	got := parseOfferCandidates(sdp)
	if len(got) != 1 {
		t.Fatalf("expected only the valid line to parse, got %d", len(got))
	}
}
