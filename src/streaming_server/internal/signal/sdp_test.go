package signal

import (
	"net"
	"strings"
	"testing"
)

func TestGenerateAnswerEmitsCandidatePerIP(t *testing.T) {
	ips := []net.IP{
		net.ParseIP("192.168.1.33").To4(),
		net.ParseIP("100.74.116.110").To4(),
	}

	answer := GenerateAnswer(&AnswerParams{
		ICEUfrag:        "abcd",
		ICEPwd:          "0123456789abcdef012345",
		DTLSFingerprint: "AA:BB",
		CandidateIPs:    ips,
		CandidatePort:   20000,
		PayloadType:     35,
		MID:             "0",
	})

	for _, ip := range ips {
		want := "typ host"
		line := findCandidateLine(answer, ip.String())
		if line == "" {
			t.Fatalf("no candidate line for %s in:\n%s", ip, answer)
		}
		if !strings.Contains(line, want) {
			t.Errorf("candidate for %s missing %q: %s", ip, want, line)
		}
	}

	// Foundations must differ across candidates (RFC 8445 §5.1.1.3).
	if strings.Count(answer, "a=candidate:1 ") != 1 {
		t.Errorf("expected exactly one candidate with foundation 1, got:\n%s", answer)
	}
	if strings.Count(answer, "a=candidate:2 ") != 1 {
		t.Errorf("expected exactly one candidate with foundation 2, got:\n%s", answer)
	}
}

func TestGenerateAnswerSingleCandidate(t *testing.T) {
	ips := []net.IP{net.ParseIP("10.0.0.1").To4()}

	answer := GenerateAnswer(&AnswerParams{
		ICEUfrag:        "abcd",
		ICEPwd:          "0123456789abcdef012345",
		DTLSFingerprint: "AA:BB",
		CandidateIPs:    ips,
		CandidatePort:   20000,
		PayloadType:     35,
		MID:             "0",
	})

	if got := strings.Count(answer, "a=candidate:"); got != 1 {
		t.Errorf("expected 1 candidate line, got %d:\n%s", got, answer)
	}
	if !strings.Contains(answer, "c=IN IP4 10.0.0.1\r\n") {
		t.Errorf("c= line should reference the only candidate IP:\n%s", answer)
	}
}

func TestGenerateAnswerEmptyCandidatesFallsBack(t *testing.T) {
	answer := GenerateAnswer(&AnswerParams{
		ICEUfrag:        "abcd",
		ICEPwd:          "0123456789abcdef012345",
		DTLSFingerprint: "AA:BB",
		CandidatePort:   20000,
		PayloadType:     35,
		MID:             "0",
	})
	if !strings.Contains(answer, "a=candidate:1 1 udp ") {
		t.Errorf("fallback should still produce a candidate line:\n%s", answer)
	}
	if !strings.Contains(answer, "127.0.0.1") {
		t.Errorf("expected loopback fallback IP:\n%s", answer)
	}
}

// findCandidateLine returns the single SDP line containing the given
// substring, or empty string if not found.
func findCandidateLine(sdp, sub string) string {
	for _, line := range strings.Split(sdp, "\r\n") {
		if strings.HasPrefix(line, "a=candidate:") && strings.Contains(line, sub) {
			return line
		}
	}
	return ""
}

func TestParseOfferCapturesFmtpLine(t *testing.T) {
	offerSDP := strings.Join([]string{
		"v=0",
		"o=- 1 2 IN IP4 0.0.0.0",
		"s=-",
		"t=0 0",
		"a=group:BUNDLE 0",
		"m=video 9 UDP/TLS/RTP/SAVPF 35",
		"c=IN IP4 0.0.0.0",
		"a=ice-ufrag:abcd",
		"a=ice-pwd:0123456789abcdef012345",
		"a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
		"a=setup:actpass",
		"a=mid:0",
		"a=rtpmap:35 H265/90000",
		"a=fmtp:35 level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST",
		"a=sendrecv",
		"",
	}, "\r\n")

	offer, err := ParseOffer(offerSDP)
	if err != nil {
		t.Fatalf("ParseOffer: %v", err)
	}
	want := "a=fmtp:35 level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST"
	if offer.FmtpLine != want {
		t.Errorf("FmtpLine = %q, want %q", offer.FmtpLine, want)
	}
}

func TestGenerateAnswerEmitsIPv6Connection(t *testing.T) {
	v6 := net.ParseIP("240d:f:dd4:d800:a4e3:36ff:fea9:bcc6")
	v4 := net.ParseIP("192.168.1.10").To4()
	answer := GenerateAnswer(&AnswerParams{
		ICEUfrag:        "abcd",
		ICEPwd:          "0123456789abcdef012345",
		DTLSFingerprint: "AA:BB",
		CandidateIPs:    []net.IP{v6, v4},
		CandidatePort:   20000,
		PayloadType:     35,
		MID:             "0",
	})
	// Primary is the first IP (v6) → c= must declare IP6.
	if !strings.Contains(answer, "c=IN IP6 240d:f:dd4:d800:a4e3:36ff:fea9:bcc6\r\n") {
		t.Errorf("c= line should declare v6 primary:\n%s", answer)
	}
	if !strings.Contains(answer, "a=rtcp:20000 IN IP6 ") {
		t.Errorf("a=rtcp should match c= address family:\n%s", answer)
	}
	// Both candidates must appear; v6 first so it gets higher priority.
	if !strings.Contains(answer, "a=candidate:1 1 udp ") || !strings.Contains(answer, "240d:f:dd4:d800:a4e3:36ff:fea9:bcc6 20000 typ host") {
		t.Errorf("v6 host candidate missing:\n%s", answer)
	}
	if !strings.Contains(answer, "192.168.1.10 20000 typ host") {
		t.Errorf("v4 host candidate missing:\n%s", answer)
	}
}

func TestGenerateAnswerV4OnlyKeepsIP4(t *testing.T) {
	answer := GenerateAnswer(&AnswerParams{
		ICEUfrag:        "abcd",
		ICEPwd:          "0123456789abcdef012345",
		DTLSFingerprint: "AA:BB",
		CandidateIPs:    []net.IP{net.ParseIP("192.168.1.10").To4()},
		CandidatePort:   20000,
		PayloadType:     35,
		MID:             "0",
	})
	if !strings.Contains(answer, "c=IN IP4 192.168.1.10\r\n") {
		t.Errorf("v4-only path should keep c=IN IP4:\n%s", answer)
	}
}

func TestGenerateAnswerICEFullOmitsICELite(t *testing.T) {
	answer := GenerateAnswer(&AnswerParams{
		ICEUfrag:        "abcd",
		ICEPwd:          "0123456789abcdef012345",
		DTLSFingerprint: "AA:BB",
		CandidateIPs:    []net.IP{net.ParseIP("10.0.0.1").To4()},
		CandidatePort:   20000,
		PayloadType:     35,
		MID:             "0",
		ICEFull:         true,
	})
	if strings.Contains(answer, "a=ice-lite") {
		t.Errorf("ICEFull=true should omit a=ice-lite:\n%s", answer)
	}
}

func TestGenerateAnswerDefaultsToICELite(t *testing.T) {
	answer := GenerateAnswer(&AnswerParams{
		ICEUfrag:        "abcd",
		ICEPwd:          "0123456789abcdef012345",
		DTLSFingerprint: "AA:BB",
		CandidateIPs:    []net.IP{net.ParseIP("10.0.0.1").To4()},
		CandidatePort:   20000,
		PayloadType:     35,
		MID:             "0",
	})
	if !strings.Contains(answer, "a=ice-lite\r\n") {
		t.Errorf("default should include a=ice-lite:\n%s", answer)
	}
}

func TestParseOfferCapturesCandidateLines(t *testing.T) {
	offerSDP := strings.Join([]string{
		"v=0",
		"m=video 9 UDP/TLS/RTP/SAVPF 35",
		"c=IN IP4 0.0.0.0",
		"a=ice-ufrag:abcd",
		"a=ice-pwd:0123456789abcdef012345",
		"a=fingerprint:sha-256 AA:BB:CC:DD",
		"a=setup:actpass",
		"a=mid:0",
		"a=rtpmap:35 H265/90000",
		"a=candidate:1 1 udp 2113937151 192.168.1.10 50000 typ host",
		"a=candidate:2 1 udp 1677729535 203.0.113.45 60000 typ srflx raddr 192.168.1.10 rport 50000",
		"",
	}, "\r\n")

	offer, err := ParseOffer(offerSDP)
	if err != nil {
		t.Fatalf("ParseOffer: %v", err)
	}
	if len(offer.Candidates) != 2 {
		t.Fatalf("expected 2 candidates parsed, got %d", len(offer.Candidates))
	}
	if offer.Candidates[1].Type != CandidateServerReflexive {
		t.Errorf("second candidate should be srflx, got %s", offer.Candidates[1].Type)
	}
}

func TestGenerateAnswerEchoesFmtp(t *testing.T) {
	answer := GenerateAnswer(&AnswerParams{
		ICEUfrag:        "abcd",
		ICEPwd:          "0123456789abcdef012345",
		DTLSFingerprint: "AA:BB",
		CandidateIPs:    []net.IP{net.ParseIP("10.0.0.1").To4()},
		CandidatePort:   20000,
		PayloadType:     35,
		MID:             "0",
		FmtpLine:        "a=fmtp:35 level-id=180;profile-id=1;tier-flag=0",
	})
	if !strings.Contains(answer, "a=fmtp:35 level-id=180;profile-id=1;tier-flag=0\r\n") {
		t.Errorf("answer missing echoed fmtp:\n%s", answer)
	}
}
