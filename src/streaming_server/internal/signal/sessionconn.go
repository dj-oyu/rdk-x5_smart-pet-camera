package signal

import (
	"fmt"
	"net"

	"golang.org/x/net/ipv6"
)

// sessionConn writes UDP packets on behalf of a Session and pins the
// source IPv6 address via IPV6_PKTINFO so DTLS / SRTP / STUN-response
// packets all carry the same source the SDP host candidate advertises.
//
// Why this matters: without the pin, Linux's RFC 6724 source selection
// picks whatever address it considers most appropriate on the egress
// interface — by default the RFC 4941 temporary v6 — and the source IP
// drifts away from the mngtmpaddr we put in the candidate. ICE swallows
// the discrepancy (peer-reflexive discovery) but pion/dtls and Safari
// drop every packet whose 5-tuple doesn't match the negotiated pair,
// so the handshake stalls forever.
//
// v4 destinations and sessions without a v6 source bypass the pinner;
// the kernel default is fine there because the per-interface v4 source
// is usually unambiguous.
type sessionConn struct {
	udp   *net.UDPConn
	pc6   *ipv6.PacketConn // wraps udp; nil when no v6 source is needed
	src6  net.IP
	ifIdx int
}

// newSessionConn returns a writer for the given UDP socket. If v6Src is
// nil or v4, the pinner is left disabled — write calls pass straight
// through to *net.UDPConn.
func newSessionConn(udp *net.UDPConn, v6Src net.IP) *sessionConn {
	sc := &sessionConn{udp: udp}
	if v6Src != nil && v6Src.To4() == nil {
		sc.pc6 = ipv6.NewPacketConn(udp)
		sc.src6 = v6Src
		sc.ifIdx, _ = interfaceIndexForIP(v6Src)
	}
	return sc
}

// WriteToUDP sends b to dst, pinning the source when dst is v6 and a
// v6 source is configured.
func (s *sessionConn) WriteToUDP(b []byte, dst *net.UDPAddr) (int, error) {
	if s.pc6 != nil && dst != nil && dst.IP.To4() == nil {
		cm := &ipv6.ControlMessage{Src: s.src6, IfIndex: s.ifIdx}
		return s.pc6.WriteTo(b, cm, dst)
	}
	if dst == nil {
		return 0, fmt.Errorf("sessionconn: nil dst")
	}
	return s.udp.WriteToUDP(b, dst)
}

// interfaceIndexForIP returns the index of the interface that owns ip.
func interfaceIndexForIP(ip net.IP) (int, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return 0, err
	}
	for _, iface := range ifaces {
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			if ipNet.IP.Equal(ip) {
				return iface.Index, nil
			}
		}
	}
	return 0, fmt.Errorf("v6pin: no interface owns %s", ip)
}

// firstV6 returns the first IPv6 (non-mapped) entry in ips, or nil.
func firstV6(ips []net.IP) net.IP {
	for _, ip := range ips {
		if ip.To4() == nil && ip.To16() != nil {
			return ip
		}
	}
	return nil
}
