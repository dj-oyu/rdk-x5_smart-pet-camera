package signal

import (
	"encoding/hex"
	"net"
	"os"
	"strconv"
	"strings"
)

// Linux IFA_F_* flag bits we care about, low byte (matches the value
// /proc/net/if_inet6 exposes per address). Full enum lives in
// include/uapi/linux/if_addr.h.
const (
	ifaFlagTemporary  uint8 = 0x01
	ifaFlagDeprecated uint8 = 0x20
)

// linuxV6Flags maps an IPv6 address (in net.IP.String() form) to the
// low byte of IFA_F_* flags. Built from /proc/net/if_inet6; empty on
// non-Linux platforms or when the file is unreadable, in which case
// callers must keep all v6 addresses.
type linuxV6Flags map[string]uint8

// readLinuxV6Flags parses /proc/net/if_inet6. Each line is
//
//	<32-hex address> <ifindex> <prefix> <scope> <flags> <devname>
//
// (https://www.kernel.org/doc/Documentation/networking/proc_net_dev.rst —
// see if_inet6 description). Returns empty map on any error; callers fall
// back to "no flag-based filtering".
func readLinuxV6Flags() linuxV6Flags {
	data, err := os.ReadFile("/proc/net/if_inet6")
	if err != nil {
		return linuxV6Flags{}
	}
	return parseLinuxV6Flags(string(data))
}

func parseLinuxV6Flags(s string) linuxV6Flags {
	out := make(linuxV6Flags)
	for _, line := range strings.Split(s, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		raw, err := hex.DecodeString(fields[0])
		if err != nil || len(raw) != 16 {
			continue
		}
		ip := net.IP(raw)
		// flags field is hex without 0x prefix
		flags, err := strconv.ParseUint(fields[4], 16, 16)
		if err != nil {
			continue
		}
		out[ip.String()] = uint8(flags & 0xff)
	}
	return out
}

// isULA reports whether ip falls inside the IPv6 ULA range fc00::/7
// (RFC 4193). ULA addresses are not internet-routable and would only
// confuse remote ICE peers.
func isULA(ip net.IP) bool {
	if v6 := ip.To16(); v6 != nil && ip.To4() == nil {
		return v6[0]&0xfe == 0xfc
	}
	return false
}

// candidateAddrFilter is the pure (testable) filter: given parsed
// addresses and the v6 flag map, return the IPs we want to advertise
// as ICE host candidates in priority order (v6 first, v4 second).
//
// Filtering rules:
//   - drop loopback and link-local
//   - drop ULA (fc00::/7) — not internet-routable
//   - drop IPv6 addresses flagged temporary or deprecated by the
//     kernel: temporary addresses rotate periodically and break
//     long-running sessions; deprecated addresses are on their way
//     out and unsuitable for new connections
//   - when includeV6 is false, drop every v6 address
func candidateAddrFilter(addrs []*net.IPNet, includeV6 bool, v6Flags linuxV6Flags) []net.IP {
	var v4, v6 []net.IP
	for _, ipNet := range addrs {
		ip := ipNet.IP
		if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			continue
		}
		if ip4 := ip.To4(); ip4 != nil {
			v4 = append(v4, ip4)
			continue
		}
		if !includeV6 {
			continue
		}
		if !ip.IsGlobalUnicast() {
			continue
		}
		if isULA(ip) {
			continue
		}
		if f, ok := v6Flags[ip.String()]; ok {
			if f&(ifaFlagTemporary|ifaFlagDeprecated) != 0 {
				continue
			}
		}
		v6 = append(v6, ip)
	}
	// Browsers/ICE prefer the candidate appearing first in the SDP at
	// equal priority; emit v6 before v4 so the v6 direct path wins
	// when both work.
	return append(v6, v4...)
}

// getLocalCandidateAddrs is the IO wrapper around candidateAddrFilter.
// Falls back to 127.0.0.1 if nothing usable was found, mirroring the
// pre-Phase-B getLocalIPs behaviour so tests/dev rigs without a real
// network keep working.
func getLocalCandidateAddrs(includeV6 bool) []net.IP {
	raw, _ := net.InterfaceAddrs()
	nets := make([]*net.IPNet, 0, len(raw))
	for _, a := range raw {
		if n, ok := a.(*net.IPNet); ok {
			nets = append(nets, n)
		}
	}
	ips := candidateAddrFilter(nets, includeV6, readLinuxV6Flags())
	if len(ips) == 0 {
		ips = append(ips, net.IPv4(127, 0, 0, 1))
	}
	return ips
}
