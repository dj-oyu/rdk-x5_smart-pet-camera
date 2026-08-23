package signal

import "testing"

func TestCloseSessionRemovesSessionImmediately(t *testing.T) {
	masterKey := testHex("E1F97A0D3E018BE0D64FA32C06DE4139")
	masterSalt := testHex("0EC675AD498AFEEBB6960B3AABE6")
	srv, sess, cleanup := newTestSession(t, masterKey, masterSalt)
	defer cleanup()

	if got := srv.GetClientCount(); got != 1 {
		t.Fatalf("client count before close = %d, want 1", got)
	}

	if !srv.CloseSession(sess.id) {
		t.Fatal("CloseSession returned false for an active session")
	}
	if got := srv.GetClientCount(); got != 0 {
		t.Fatalf("client count after close = %d, want 0", got)
	}

	srv.mu.RLock()
	_, stillPresent := srv.sessions[sess.id]
	srv.mu.RUnlock()
	if stillPresent {
		t.Fatal("closed session remains in the session map")
	}

	// Normal timeout cleanup may race with an explicit close. Repeating the
	// request must therefore be harmless.
	if srv.CloseSession(sess.id) {
		t.Fatal("closing an already-removed session returned true")
	}
}
