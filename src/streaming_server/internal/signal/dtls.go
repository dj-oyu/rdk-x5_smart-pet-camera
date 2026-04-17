package signal

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"math/big"
	"net"
	"strings"
	"time"

	"github.com/pion/dtls/v3"
	"github.com/pion/dtls/v3/pkg/crypto/selfsign"
)

// DTLSConfig holds DTLS configuration for the server.
type DTLSConfig struct {
	Certificate tls.Certificate
	Fingerprint string // SHA-256 fingerprint "XX:XX:XX:..."
}

// NewDTLSConfig generates a self-signed ECDSA certificate for DTLS.
func NewDTLSConfig() (*DTLSConfig, error) {
	cert, err := selfsign.GenerateSelfSigned()
	if err != nil {
		return nil, fmt.Errorf("dtls: generate cert: %w", err)
	}

	// Compute SHA-256 fingerprint
	x509Cert, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("dtls: parse cert: %w", err)
	}
	hash := sha256.Sum256(x509Cert.Raw)
	fp := formatFingerprint(hash[:])

	return &DTLSConfig{
		Certificate: cert,
		Fingerprint: fp,
	}, nil
}

// DTLSSession wraps a pion/dtls connection for SRTP key extraction.
type DTLSSession struct {
	conn *dtls.Conn
}

// HandshakeDTLS performs DTLS handshake as server on the given packet connection.
// The conn should already be multiplexed (STUN/DTLS/SRTP demuxed).
func HandshakeDTLS(conn net.PacketConn, remoteAddr net.Addr, config *DTLSConfig) (*DTLSSession, error) {
	dtlsConfig := &dtls.Config{
		Certificates:         []tls.Certificate{config.Certificate},
		ExtendedMasterSecret: dtls.RequireExtendedMasterSecret,
		SRTPProtectionProfiles: []dtls.SRTPProtectionProfile{
			dtls.SRTP_AES128_CM_HMAC_SHA1_80,
		},
		// We are server (passive in SDP setup)
		InsecureSkipVerify: true, // Browser cert is not pre-known
	}

	// pion/dtls manages its own timeouts internally via SetReadDeadline.
	// Ensure no residual deadline from ICE phase.
	conn.SetReadDeadline(time.Time{})

	dtlsConn, err := dtls.Server(conn, remoteAddr, dtlsConfig)
	if err != nil {
		return nil, fmt.Errorf("dtls: create conn failed: %w", err)
	}

	// dtls.Server() returns immediately; handshake runs on first Read/Write.
	// We must explicitly trigger it and wait for completion.
	if err := dtlsConn.HandshakeContext(context.Background()); err != nil {
		dtlsConn.Close()
		return nil, fmt.Errorf("dtls: handshake failed: %w", err)
	}

	return &DTLSSession{conn: dtlsConn}, nil
}

// ExportSRTPKeys extracts SRTP keying material from the DTLS connection.
// Returns the raw keying material (RFC 5764).
// For AES128_CM_HMAC_SHA1_80: keyLen=16, saltLen=14.
func (s *DTLSSession) ExportSRTPKeys() (keyMaterial []byte, err error) {
	keyLen := 16  // AES-128
	saltLen := 14 // AES-CM

	// Total: clientWriteKey(16) + serverWriteKey(16) + clientWriteSalt(14) + serverWriteSalt(14) = 60
	totalLen := 2*keyLen + 2*saltLen

	state, ok := s.conn.ConnectionState()
	if !ok {
		return nil, fmt.Errorf("dtls: connection state not available")
	}
	keyMaterial, err = state.ExportKeyingMaterial("EXTRACTOR-dtls_srtp", nil, totalLen)
	if err != nil {
		return nil, fmt.Errorf("dtls: export keying material: %w", err)
	}

	return keyMaterial, nil
}

// Close closes the DTLS connection.
func (s *DTLSSession) Close() error {
	if s.conn != nil {
		return s.conn.Close()
	}
	return nil
}

// formatFingerprint formats a hash as "XX:XX:XX:..." for SDP.
func formatFingerprint(hash []byte) string {
	parts := make([]string, len(hash))
	for i, b := range hash {
		parts[i] = hex.EncodeToString([]byte{b})
	}
	return strings.ToUpper(strings.Join(parts, ":"))
}

// generateSelfSignedCert is a fallback if pion/dtls selfsign is unavailable.
func generateSelfSignedCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(24 * time.Hour),
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}

	return tls.Certificate{
		Certificate: [][]byte{certDER},
		PrivateKey:  key,
	}, nil
}
