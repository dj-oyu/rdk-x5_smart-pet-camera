// Package srtp implements SRTP (RFC 3711) encryption using Linux AF_ALG
// for hardware-accelerated AES-CTR and HMAC-SHA1 on OP-TEE enabled SoCs.
package srtp

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/binary"
	"fmt"
	"hash"
	"os"
	"sync"
	"syscall"
	"unsafe"
)

const (
	afALG     = 38  // AF_ALG address family
	solALG    = 279 // SOL_ALG socket option level
	algSetKey = 1   // ALG_SET_KEY
	algSetOp  = 3   // ALG_SET_OP (cmsg type for sendmsg)

	// --- OP-TEE TE driver encrypt/decrypt workaround ---
	// The ecb-aes-te driver on this SoC has ALG_OP_ENCRYPT (0) and
	// ALG_OP_DECRYPT (1) swapped: sending ALG_OP_DECRYPT actually
	// performs AES encryption (verified against NIST test vectors).
	// We name this constant by what it DOES, not by the kernel enum.
	algOpActualEncrypt = 1 // kernel calls this "DECRYPT", TE driver encrypts
)

// sockaddrALG is the Go equivalent of struct sockaddr_alg.
type sockaddrALG struct {
	Family uint16
	Type   [14]byte
	Feat   uint32
	Mask   uint32
	Name   [64]byte
}

// afalgAvailable caches whether AF_ALG sockets can be created.
var afalgAvailable = sync.OnceValue(func() bool {
	fd, err := syscall.Socket(afALG, syscall.SOCK_SEQPACKET, 0)
	if err != nil {
		return false
	}
	syscall.Close(fd)
	return true
})

// afalgAccept calls accept4(fd, NULL, NULL, SOCK_CLOEXEC) directly.
// Go's syscall.Accept passes a 112-byte RawSockaddrAny buffer which
// the OP-TEE AF_ALG driver rejects with ECONNABORTED. AF_ALG has no
// peer address, so NULL is the correct argument.
func afalgAccept(fd int) (int, error) {
	opfd, _, errno := syscall.Syscall6(syscall.SYS_ACCEPT4,
		uintptr(fd), 0, 0, uintptr(syscall.SOCK_CLOEXEC), 0, 0)
	if errno != 0 {
		return -1, errno
	}
	return int(opfd), nil
}

// afalgEncryptOOB is a pre-built cmsg (out-of-band data) for sendmsg.
// Sets ALG_SET_OP = algOpActualEncrypt so the TE driver performs AES
// encryption. Built once at init time and reused for every EncryptBlocks call.
var afalgEncryptOOB = func() []byte {
	space := syscall.CmsgSpace(4)
	buf := make([]byte, space)
	hdr := (*syscall.Cmsghdr)(unsafe.Pointer(&buf[0]))
	hdr.SetLen(syscall.CmsgLen(4))
	hdr.Level = solALG
	hdr.Type = algSetOp
	dataOffset := syscall.CmsgLen(0)
	binary.NativeEndian.PutUint32(buf[dataOffset:], algOpActualEncrypt)
	return buf
}()

// ----- AES Block via AF_ALG -----

// afalgBlock implements cipher.Block using AF_ALG skcipher("ecb(aes)").
// ECB mode encrypts a single 16-byte block — exactly what cipher.Block requires.
// The SRTP xorBytesCTR function uses Block.Encrypt() to build CTR keystream.
type afalgBlock struct {
	fd   int // AF_ALG accept fd (operation socket)
	size int // block size (always 16 for AES)
}

// newAFALGBlock creates an AES cipher.Block backed by AF_ALG.
func newAFALGBlock(key []byte) (cipher.Block, error) {
	fd, err := syscall.Socket(afALG, syscall.SOCK_SEQPACKET, 0)
	if err != nil {
		return nil, fmt.Errorf("af_alg socket: %w", err)
	}

	sa := sockaddrALG{Family: afALG}
	copy(sa.Type[:], "skcipher")
	copy(sa.Name[:], "ecb(aes)")

	_, _, errno := syscall.Syscall(syscall.SYS_BIND, uintptr(fd),
		uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa))
	if errno != 0 {
		syscall.Close(fd)
		return nil, fmt.Errorf("af_alg bind: %v", errno)
	}

	// Set key
	err = syscall.SetsockoptString(fd, solALG, algSetKey, string(key))
	if err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("af_alg set key: %w", err)
	}

	// Accept to get operation fd
	opfd, err := afalgAccept(fd)
	syscall.Close(fd) // parent fd no longer needed
	if err != nil {
		return nil, fmt.Errorf("af_alg accept: %w", err)
	}

	return &afalgBlock{fd: opfd, size: aes.BlockSize}, nil
}

func (b *afalgBlock) BlockSize() int { return b.size }

func (b *afalgBlock) Encrypt(dst, src []byte) {
	// Write plaintext, read ciphertext
	syscall.Write(b.fd, src[:b.size])
	syscall.Read(b.fd, dst[:b.size])
}

func (b *afalgBlock) Decrypt(dst, src []byte) {
	// SRTP only needs encrypt (CTR mode uses encrypt for both directions)
	b.Encrypt(dst, src)
}

// Close releases the AF_ALG operation fd.
func (b *afalgBlock) Close() error {
	return syscall.Close(b.fd)
}

// ----- HMAC-SHA1 via AF_ALG -----

// afalgHMAC implements hash.Hash using AF_ALG hash("hmac(sha1)").
type afalgHMAC struct {
	parentFD int // bind fd (kept for Reset → re-accept)
	opFD     int // current operation fd
	size     int // digest size (20 for SHA1)
	written  bool
}

// newAFALGHMAC creates an HMAC-SHA1 hash.Hash backed by AF_ALG.
func newAFALGHMAC(key []byte) (hash.Hash, error) {
	fd, err := syscall.Socket(afALG, syscall.SOCK_SEQPACKET, 0)
	if err != nil {
		return nil, fmt.Errorf("af_alg socket: %w", err)
	}

	sa := sockaddrALG{Family: afALG}
	copy(sa.Type[:], "hash")
	copy(sa.Name[:], "hmac(sha1)")

	_, _, errno := syscall.Syscall(syscall.SYS_BIND, uintptr(fd),
		uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa))
	if errno != 0 {
		syscall.Close(fd)
		return nil, fmt.Errorf("af_alg bind: %w", errno)
	}

	err = syscall.SetsockoptString(fd, solALG, algSetKey, string(key))
	if err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("af_alg set key: %w", err)
	}

	opfd, err := afalgAccept(fd)
	if err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("af_alg accept: %w", err)
	}

	return &afalgHMAC{parentFD: fd, opFD: opfd, size: sha1.Size}, nil
}

func (h *afalgHMAC) Write(p []byte) (int, error) {
	// Use sendmsg with MSG_MORE to indicate more data will follow.
	// The TE hash driver does not support incremental hashing via
	// plain write(2) — multiple writes produce incorrect digests.
	// MSG_MORE tells the kernel to buffer without finalizing.
	if err := syscall.Sendmsg(h.opFD, p, nil, nil, syscall.MSG_MORE); err != nil {
		return 0, err
	}
	h.written = true
	return len(p), nil
}

func (h *afalgHMAC) Sum(b []byte) []byte {
	// Send empty without MSG_MORE to finalize the hash, then read digest.
	syscall.Sendmsg(h.opFD, nil, nil, nil, 0)
	digest := make([]byte, h.size)
	syscall.Read(h.opFD, digest)
	return append(b, digest...)
}

func (h *afalgHMAC) Reset() {
	// Close current op fd, re-accept for fresh state
	syscall.Close(h.opFD)
	h.opFD, _ = afalgAccept(h.parentFD)
	h.written = false
}

func (h *afalgHMAC) Size() int      { return h.size }
func (h *afalgHMAC) BlockSize() int { return 64 } // SHA1 block size

// Close releases both AF_ALG fds.
func (h *afalgHMAC) Close() error {
	syscall.Close(h.opFD)
	return syscall.Close(h.parentFD)
}

// ----- AF_ALG batch ECB for CTR keystream generation -----

// afalgBatchBlock implements batch AES-ECB encryption: encrypts multiple
// 16-byte blocks in a single send+recv syscall pair. This generates
// CTR keystream much faster than per-block Encrypt() calls.
type afalgBatchBlock struct {
	parentFD int
	opFD     int
}

func newAFALGBatchBlock(key []byte) (*afalgBatchBlock, error) {
	fd, err := syscall.Socket(afALG, syscall.SOCK_SEQPACKET, 0)
	if err != nil {
		return nil, fmt.Errorf("socket: %w", err)
	}

	sa := sockaddrALG{Family: afALG}
	copy(sa.Type[:], "skcipher")
	copy(sa.Name[:], "ecb(aes)")

	_, _, errno := syscall.Syscall(syscall.SYS_BIND, uintptr(fd),
		uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa))
	if errno != 0 {
		syscall.Close(fd)
		return nil, fmt.Errorf("bind: %v", errno)
	}

	err = syscall.SetsockoptString(fd, solALG, algSetKey, string(key))
	if err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("setkey: %w", err)
	}

	opfd, err := afalgAccept(fd)
	if err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("accept: %w", err)
	}

	// Verify the socket works by encrypting one test block via sendmsg.
	test := make([]byte, 16)
	if err := syscall.Sendmsg(opfd, test, afalgEncryptOOB, nil, 0); err != nil {
		syscall.Close(opfd)
		syscall.Close(fd)
		return nil, fmt.Errorf("test sendmsg: %w", err)
	}
	result := make([]byte, 16)
	if _, err := syscall.Read(opfd, result); err != nil {
		syscall.Close(opfd)
		syscall.Close(fd)
		return nil, fmt.Errorf("test read: %w", err)
	}

	return &afalgBatchBlock{parentFD: fd, opFD: opfd}, nil
}

// EncryptBlocks encrypts multiple 16-byte blocks in a single syscall pair.
// Input must be a multiple of 16 bytes.
//
// Uses sendmsg with ALG_SET_OP cmsg to request encryption direction.
// The OP-TEE TE driver has encrypt/decrypt swapped — afalgEncryptOOB
// contains the correct op value (verified against NIST AES test vectors).
//
// The operation fd is reused across calls (no re-accept needed when
// each sendmsg includes the ALG_SET_OP cmsg).
func (b *afalgBatchBlock) EncryptBlocks(dst, src []byte) error {
	if err := syscall.Sendmsg(b.opFD, src, afalgEncryptOOB, nil, 0); err != nil {
		return err
	}
	// Use raw read(2) instead of Recvmsg to avoid Go's anyToSockaddr
	// parsing on the returned AF_ALG address, which would return
	// EAFNOSUPPORT and mask a successful read.
	if _, err := syscall.Read(b.opFD, dst); err != nil {
		return err
	}
	return nil
}

func (b *afalgBatchBlock) Close() error {
	syscall.Close(b.opFD)
	return syscall.Close(b.parentFD)
}

// NewAESBatchBlock creates an AF_ALG batch ECB encryptor for CTR keystream.
// Returns nil if AF_ALG is not available.
func NewAESBatchBlock(key []byte) *afalgBatchBlock {
	if !afalgAvailable() {
		fmt.Fprintf(os.Stderr, "[srtp] AF_ALG not available\n")
		return nil
	}
	b, err := newAFALGBatchBlock(key)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[srtp] AF_ALG batch block error: %v\n", err)
		return nil
	}
	return b
}

// ----- Factory functions with automatic fallback -----

// NewAESBlock creates an AES cipher.Block using AF_ALG if available,
// falling back to Go's crypto/aes otherwise.
func NewAESBlock(key []byte) (cipher.Block, error) {
	if afalgAvailable() {
		block, err := newAFALGBlock(key)
		if err == nil {
			return block, nil
		}
		// Fall through to software
	}
	return aes.NewCipher(key)
}

// NewHMACSHA1 creates an HMAC-SHA1 hash.Hash using AF_ALG if available,
// falling back to Go's crypto/hmac otherwise.
func NewHMACSHA1(key []byte) (hash.Hash, error) {
	if afalgAvailable() {
		h, err := newAFALGHMAC(key)
		if err == nil {
			return h, nil
		}
		// Fall through to software
	}
	return hmac.New(sha1.New, key), nil
}

// Closeable is implemented by AF_ALG-backed types that hold OS resources.
type Closeable interface {
	Close() error
}

// CloseIfNeeded closes c if it implements Closeable (AF_ALG types).
func CloseIfNeeded(c interface{}) {
	if cl, ok := c.(Closeable); ok {
		cl.Close()
	}
}
