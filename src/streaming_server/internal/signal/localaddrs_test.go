package signal

import (
	"net"
	"testing"
)

// helper: build IPNet by parsing a CIDR
func cidr(s string) *net.IPNet {
	_, ipNet, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	// Embed the host address, not the network address (ParseCIDR returns
	// the network on .IP; tests want the host bits we wrote).
	ip, _, _ := net.ParseCIDR(s)
	return &net.IPNet{IP: ip, Mask: ipNet.Mask}
}

func TestCandidateAddrFilter_KeepsV4AndStableV6(t *testing.T) {
	// Sample modelled after the RDK X5 device:
	//   - 1 v4 GUA on LAN
	//   - 1 v6 mngtmpaddr (stable SLAAC, no temp/deprecated flag)
	//   - 1 v6 temporary (rotates every hours, should drop)
	//   - 1 v6 deprecated (on its way out, should drop)
	//   - 1 v6 link-local fe80::/10 (drop)
	//   - 1 v6 ULA fd... (drop, not internet routable)
	//   - 1 v4 loopback (drop)
	addrs := []*net.IPNet{
		cidr("192.168.1.10/24"),
		cidr("240d:f:dd4:d800:a4e3:36ff:fea9:bcc6/64"), // stable
		cidr("240d:f:dd4:d800:b7fd:344d:e8c0:b331/64"), // temp
		cidr("240d:f:dd4:d800:4ff0:ddf6:7db:5f11/64"),  // deprecated
		cidr("fe80::1/64"),
		cidr("fd7a:115c:a1e0::4e32:746e/128"),
		cidr("127.0.0.1/8"),
	}
	flags := linuxV6Flags{
		"240d:f:dd4:d800:b7fd:344d:e8c0:b331": ifaFlagTemporary,
		"240d:f:dd4:d800:4ff0:ddf6:7db:5f11":  ifaFlagDeprecated | ifaFlagTemporary,
		"240d:f:dd4:d800:a4e3:36ff:fea9:bcc6": 0,
	}

	got := candidateAddrFilter(addrs, true, flags)
	if len(got) != 2 {
		t.Fatalf("expected 2 ips (1 stable v6 + 1 v4), got %d: %v", len(got), got)
	}
	if got[0].To4() != nil {
		t.Errorf("expected v6 first (priority), got v4 %s as first", got[0])
	}
	if got[1].To4() == nil {
		t.Errorf("expected v4 second, got %s", got[1])
	}
}

func TestCandidateAddrFilter_IncludeV6False(t *testing.T) {
	addrs := []*net.IPNet{
		cidr("192.168.1.10/24"),
		cidr("240d:f:dd4:d800:a4e3:36ff:fea9:bcc6/64"),
	}
	got := candidateAddrFilter(addrs, false, linuxV6Flags{})
	if len(got) != 1 {
		t.Fatalf("expected only v4 when includeV6=false, got %d: %v", len(got), got)
	}
	if got[0].To4() == nil {
		t.Errorf("expected v4 only, got %s", got[0])
	}
}

func TestCandidateAddrFilter_NoFlagsMeansKeepV6(t *testing.T) {
	// Non-Linux fallback: when /proc/net/if_inet6 isn't available the
	// flag map is empty. In that case we still keep GUA v6 (better
	// chance of working than dropping silently).
	addrs := []*net.IPNet{
		cidr("2001:db8::1/64"),
	}
	got := candidateAddrFilter(addrs, true, linuxV6Flags{})
	if len(got) != 1 {
		t.Fatalf("expected 1 ip with empty flags, got %d", len(got))
	}
}

func TestParseLinuxV6Flags(t *testing.T) {
	// Real device sample. Address column is 32 hex chars, flags column
	// is the 5th field.
	input := `240d000f0dd4d800bce32466deb952bb 02 40 00 21     eth0
240d000f0dd4d800a4e336fffea9bcc6 02 40 00 00     eth0
240d000f0dd4d800b7fd344de8c0b331 02 40 00 01     eth0
fe80000000000000fe796d6c3a2e3971 0a 40 20 80 tailscale0
00000000000000000000000000000001 01 80 10 80       lo
`
	got := parseLinuxV6Flags(input)
	cases := map[string]uint8{
		"240d:f:dd4:d800:bce3:2466:deb9:52bb": 0x21, // temp+deprecated
		"240d:f:dd4:d800:a4e3:36ff:fea9:bcc6": 0x00, // stable mngtmpaddr
		"240d:f:dd4:d800:b7fd:344d:e8c0:b331": 0x01, // active temporary
	}
	for ip, want := range cases {
		if got[ip] != want {
			t.Errorf("flags[%s] = 0x%02x, want 0x%02x", ip, got[ip], want)
		}
	}
}

func TestIsULA(t *testing.T) {
	cases := map[string]bool{
		"fd00::1":            true,  // ULA
		"fc00::1":            true,  // ULA
		"fe80::1":            false, // link-local
		"2001:db8::1":        false, // doc range, GUA
		"240d:f:dd4:d800::1": false, // KDDI au GUA
		"192.168.1.1":        false, // not v6
	}
	for s, want := range cases {
		ip := net.ParseIP(s)
		if got := isULA(ip); got != want {
			t.Errorf("isULA(%s) = %v, want %v", s, got, want)
		}
	}
}
