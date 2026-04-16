// Package srtp implements SRTP (RFC 3711) encryption using Linux AF_ALG
// for hardware-accelerated AES-CTR and HMAC-SHA1 on OP-TEE enabled SoCs.
package srtp

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha1"
	"fmt"
	"hash"
	"os"
	"sync"
	"syscall"
	"unsafe"
)

const (
	afALG  = 38        // AF_ALG address family
	solALG = 279       // SOL_ALG socket option level
	algSetKey = 1      // ALG_SET_KEY
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
	opfd, _, err := syscall.Accept(fd)
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
	parentFD int    // bind fd (kept for Reset → re-accept)
	opFD     int    // current operation fd
	size     int    // digest size (20 for SHA1)
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

	opfd, _, err := syscall.Accept(fd)
	if err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("af_alg accept: %w", err)
	}

	return &afalgHMAC{parentFD: fd, opFD: opfd, size: sha1.Size}, nil
}

func (h *afalgHMAC) Write(p []byte) (int, error) {
	n, err := syscall.Write(h.opFD, p)
	if err != nil {
		return 0, err
	}
	h.written = true
	return n, nil
}

func (h *afalgHMAC) Sum(b []byte) []byte {
	// Send empty with MSG_MORE=0 to finalize, then read digest
	if !h.written {
		// Write empty to trigger hash computation
		syscall.Write(h.opFD, []byte{})
	}
	digest := make([]byte, h.size)
	syscall.Read(h.opFD, digest)
	return append(b, digest...)
}

func (h *afalgHMAC) Reset() {
	// Close current op fd, re-accept for fresh state
	syscall.Close(h.opFD)
	h.opFD, _, _ = syscall.Accept(h.parentFD)
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

	opfd, _, err := syscall.Accept(fd)
	if err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("accept: %w", err)
	}

	// Test that the socket works: encrypt one block
	test := make([]byte, 16)
	if _, err := syscall.Write(opfd, test); err != nil {
		syscall.Close(opfd)
		syscall.Close(fd)
		return nil, fmt.Errorf("test write: %w", err)
	}
	result := make([]byte, 16)
	if _, err := syscall.Read(opfd, result); err != nil {
		syscall.Close(opfd)
		syscall.Close(fd)
		return nil, fmt.Errorf("test read: %w", err)
	}

	return &afalgBatchBlock{parentFD: fd, opFD: opfd}, nil
}

// EncryptBlocks encrypts multiple 16-byte blocks in one syscall.
// Input must be a multiple of 16 bytes.
// Re-accepts the operation fd for each call — AF_ALG skcipher sessions
// are single-use (one send→recv pair per accept).
func (b *afalgBatchBlock) EncryptBlocks(dst, src []byte) error {
	// Close previous op fd and get a fresh one
	syscall.Close(b.opFD)
	var err error
	b.opFD, _, err = syscall.Accept(b.parentFD)
	if err != nil {
		return err
	}
	if _, err := syscall.Write(b.opFD, src); err != nil {
		return err
	}
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

