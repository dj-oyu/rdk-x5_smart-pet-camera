package srtp

import (
	"crypto/aes"
	"fmt"
	"sync"
)

// Context manages SRTP session state for one direction (send or receive).
type Context struct {
	mu     sync.Mutex
	cipher *Cipher

	// ROC tracking per SSRC
	ssrcStates map[uint32]*ssrcState
}

type ssrcState struct {
	roc     uint32 // Rollover Counter
	lastSeq uint16
	seenSeq bool
}

// NewContext creates a new SRTP context from master key and salt.
// Derives session keys internally using AES-CM PRF (RFC 3711).
func NewContext(masterKey, masterSalt []byte) (*Context, error) {
	// Use software AES for key derivation (cold path, called once per session).
	// AF_ALG ECB skcipher does not reliably support repeated single-block
	// Encrypt calls on the same operation fd.
	kdfBlock, err := aes.NewCipher(masterKey)
	if err != nil {
		return nil, fmt.Errorf("srtp: kdf block: %w", err)
	}

	keyLen := len(masterKey) // 16 for AES-128

	// Derive session keys
	sessionKey, err := AesCmKeyDerivation(kdfBlock, LabelSRTPEncryption, masterSalt, keyLen)
	if err != nil {
		return nil, fmt.Errorf("srtp: derive session key: %w", err)
	}

	sessionSalt, err := AesCmKeyDerivation(kdfBlock, LabelSRTPSalt, masterSalt, 14)
	if err != nil {
		return nil, fmt.Errorf("srtp: derive session salt: %w", err)
	}

	sessionAuthKey, err := AesCmKeyDerivation(kdfBlock, LabelSRTPAuthTag, masterSalt, 20)
	if err != nil {
		return nil, fmt.Errorf("srtp: derive session auth key: %w", err)
	}

	// Create cipher with derived keys (uses AF_ALG on hot path)
	c, err := NewCipher(sessionKey, sessionSalt, sessionAuthKey)
	if err != nil {
		return nil, fmt.Errorf("srtp: create cipher: %w", err)
	}

	return &Context{
		cipher:     c,
		ssrcStates: make(map[uint32]*ssrcState),
	}, nil
}

// Close releases resources.
func (ctx *Context) Close() {
	ctx.mu.Lock()
	defer ctx.mu.Unlock()
	if ctx.cipher != nil {
		ctx.cipher.Close()
		ctx.cipher = nil
	}
}

// EncryptRTP encrypts an RTP packet. Thread-safe.
// Returns the encrypted packet with authentication tag appended.
func (ctx *Context) EncryptRTP(dst, rtpPacket []byte, headerLen int, seq uint16, ssrc uint32) ([]byte, error) {
	ctx.mu.Lock()
	roc := ctx.updateROC(ssrc, seq)
	c := ctx.cipher
	ctx.mu.Unlock()

	return c.EncryptRTP(dst, rtpPacket, headerLen, seq, roc, ssrc)
}

// updateROC updates the Rollover Counter for the given SSRC.
// Must be called with ctx.mu held.
func (ctx *Context) updateROC(ssrc uint32, seq uint16) uint32 {
	state, ok := ctx.ssrcStates[ssrc]
	if !ok {
		state = &ssrcState{}
		ctx.ssrcStates[ssrc] = state
	}

	if !state.seenSeq {
		state.lastSeq = seq
		state.seenSeq = true
		return state.roc
	}

	// Detect sequence number wrap-around (RFC 3711 Section 3.3.1)
	diff := int32(seq) - int32(state.lastSeq)
	if diff > 0 {
		// Normal increment
		state.lastSeq = seq
	} else if diff < -0x7FFF {
		// Wrap-around: seq wrapped from 0xFFFF to 0x0000
		state.roc++
		state.lastSeq = seq
	}
	// else: out-of-order or duplicate, keep current ROC

	return state.roc
}

// FromKeyMaterial creates a Context from raw DTLS-exported keying material.
// keyMaterial layout (RFC 5764):
//
//	[clientWriteKey(keyLen)] [serverWriteKey(keyLen)]
//	[clientWriteSalt(saltLen)] [serverWriteSalt(saltLen)]
//
// isClient indicates whether we are the DTLS client (false for server).
func FromKeyMaterial(keyMaterial []byte, keyLen, saltLen int, isClient bool) (*Context, error) {
	needed := 2*keyLen + 2*saltLen
	if len(keyMaterial) < needed {
		return nil, fmt.Errorf("srtp: key material too short: %d < %d", len(keyMaterial), needed)
	}

	offset := 0
	clientWriteKey := keyMaterial[offset : offset+keyLen]
	offset += keyLen
	serverWriteKey := keyMaterial[offset : offset+keyLen]
	offset += keyLen
	clientWriteSalt := keyMaterial[offset : offset+saltLen]
	offset += saltLen
	serverWriteSalt := keyMaterial[offset : offset+saltLen]

	var localKey, localSalt []byte
	if isClient {
		localKey = clientWriteKey
		localSalt = clientWriteSalt
	} else {
		localKey = serverWriteKey
		localSalt = serverWriteSalt
	}

	return NewContext(localKey, localSalt)
}

// DeriveSessionKeys is exposed for testing: derives all session keys from master key/salt.
func DeriveSessionKeys(masterKey, masterSalt []byte) (sessionKey, sessionSalt, sessionAuthKey []byte, err error) {
	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return nil, nil, nil, err
	}

	keyLen := len(masterKey)
	sessionKey, err = AesCmKeyDerivation(block, LabelSRTPEncryption, masterSalt, keyLen)
	if err != nil {
		return
	}
	sessionSalt, err = AesCmKeyDerivation(block, LabelSRTPSalt, masterSalt, 14)
	if err != nil {
		return
	}
	sessionAuthKey, err = AesCmKeyDerivation(block, LabelSRTPAuthTag, masterSalt, 20)
	if err != nil {
		return
	}
	return
}
