package signal

import (
	"fmt"
	"net"

	"golang.org/x/net/ipv6"
)

// v6SourcePinner forces an outgoing v6 UDP packet to use a specific source
// IP via IPV6_PKTINFO. Without it the kernel's RFC 6724 source selection
// will pick the first non-deprecated address on the egress interface, which
// on Linux is the RFC 4941 temporary address — different from the stable
// mngtmpaddr we advertise as a host candidate. The mismatch is harmless to
// ICE (browsers are lenient and silently discover the temp source as a
// peer-reflexive) but DTLS clients reject every packet whose 5-tuple
// doesn't match the negotiated ICE pair, so the handshake stalls forever.
//
// v4 packets and v6 packets whose source pin is nil bypass this path —
// the kernel default is fine there.
type v6SourcePinner struct {
	pc    *ipv6.PacketConn
	src   net.IP
	ifIdx int
}

// newV6SourcePinner returns a pinner that writes via udp with src as the
// IPv6 source. If src is nil or v4, returns nil — callers must fall back
// to plain *net.UDPConn writes. If the interface lookup fails we still
// return a usable pinner with ifIdx=0; the kernel then accepts the
// PKTINFO src as-is.
func newV6SourcePinner(udp *net.UDPConn, src net.IP) *v6SourcePinner {
	if src == nil || src.To4() != nil {
		return nil
	}
	ifIdx, _ := interfaceIndexForIP(src)
	return &v6SourcePinner{
		pc:    ipv6.NewPacketConn(udp),
		src:   src,
		ifIdx: ifIdx,
	}
}

// WriteToUDP sends b to dst pinning the source IP when dst is v6.
// Returns the byte count and any error from the underlying write.
func (p *v6SourcePinner) WriteToUDP(b []byte, dst *net.UDPAddr) (int, error) {
	if p == nil || dst == nil {
		return 0, fmt.Errorf("v6pin: nil pinner or dst")
	}
	cm := &ipv6.ControlMessage{Src: p.src, IfIndex: p.ifIdx}
	return p.pc.WriteTo(b, cm, dst)
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
