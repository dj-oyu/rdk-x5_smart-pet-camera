# WebRTC Streaming Server — Bug Fix Plan

コードレビュー (2026-05-28) で発見された 10 件の問題を 3 PR に分けて修正する。

---

## PR 1 — Security (`fix/webrtc-security`)

### A. STUN Binding Request の認証 — `internal/signal/ice.go:60`

**問題**: `HandleSTUN` が USERNAME / MESSAGE-INTEGRITY を検証しない。
任意のホストが ICE ハイジャックできる。

**修正**: `HandleSTUN` 内で属性を走査し、以下を検証してから `buildBindingResponse` を呼ぶ。
- USERNAME == `ice.localUfrag + ":" + ice.remoteUfrag`
- MESSAGE-INTEGRITY == `HMAC-SHA1(ice.localPwd, message_before_MI)`
- 不一致なら `return nil`（応答なし）

**影響**: `ice_full_test.go` など既存 STUN テストは valid な USERNAME/MI を送るよう fixture 更新が必要。

---

### B. DTLS peer cert fingerprint 未検証 — `internal/signal/dtls.go:60`

**問題**: `InsecureSkipVerify: true` かつ `offer.Fingerprint` が DTLS ハンドシェイクで照合されない (RFC 8122 §5 違反)。MITM 可能。

**修正**:
1. `Session` struct に `peerFingerprint string` フィールドを追加
2. `HandleOffer` で `sess.peerFingerprint = offer.Fingerprint` をセット
3. `runSession` → `HandshakeDTLS(conn, addr, config, sess.peerFingerprint)` とシグネチャを変更
4. `HandshakeDTLS` に `VerifyPeerCertificate` callback を追加:
   - `sha256.Sum256(peerCert.Raw)` を計算し `peerFingerprint` と `strings.EqualFold` で比較
   - 不一致ならハンドシェイクを abort

---

## PR 2 — Correctness (`fix/webrtc-correctness`)

### C. Shutdown 時の録画フレーム欠損 — `cmd/server/main.go:374`

**問題**: `distributeRecorder` が `ctx.Done()` で即 return し、`recorderChan`（cap=60）のキューを drain しない。末尾最大 2 秒が録画に書かれない。

**修正**:
- `readFrames` の defer に `close(s.recorderChan)` を追加（`sendWg.Wait()` の直後）
- `distributeRecorder` を `for frame := range s.recorderChan { ... }` に変更し `ctx` select を削除

シャットダウン順序: `cancel()` → readFrames 終了 → `close(recorderChan)` → distributeRecorder drain & `wg.Done()` → `wg.Wait()` → `recorder.Stop()`

---

### D. MaxClients TOCTOU 競合 — `signal/session.go:113`

**問題**: RLock でチェック後に Unlock → 別 Lock で insert するため、同時接続で上限を突破できる。

**修正**: session insert の write lock 内で最終チェックを再実施:

```go
s.mu.Lock()
if len(s.sessions) >= s.cfg.MaxClients {
    s.mu.Unlock()
    udpConn.Close()
    return nil, fmt.Errorf("signal: max clients reached (%d)", s.cfg.MaxClients)
}
s.sessions[sess.id] = sess
s.mu.Unlock()
```

先頭の楽観 RLock チェックは早期 return 用として残す。

---

### E. RTP タイムスタンプ 30fps ハードコード — `cmd/server/main.go:243`

**問題**: `ts := uint32(frame.FrameNumber * 3000)` は 30fps 固定。動的フレームレートで A/V ズレ。

**修正**: 壁時計方式に変更。sender goroutine 起動前に `streamStart := time.Now()` を宣言し:

```go
ts := uint32(time.Since(streamStart).Seconds() * 90000)
```

---

## PR 3 — Protocol + Hardening (`fix/webrtc-protocol`)

### F. SSRC 全セッション共通 — `signal/session.go:135`

**問題**: `const sessSSRC uint32 = 0x12345678` が全セッション共通。RTCP フィードバックをルーティングできない。

**修正**:
- HandleOffer で `crypto/rand` から per-session SSRC を生成
- `SendFrame` でパケットの SSRC bytes（`buf[8:12]`）を `sess.ssrc` で上書き（PT 書き換えと同箇所）

---

### G. H265 regex 大文字のみ — `signal/sdp.go:33`

**問題**: `H265/90000` のみマッチ。一部 Android/libwebrtc は `h265/90000` を lowercase で送り PT=96 フォールバックで映像なし。

**修正**: `(?i)` フラグ追加。`sdp_test.go` に lowercase fixture のテストケースを追加。

---

### H. `a=rtcp` ポート指定が RFC 5761 §5.1.3 違反 — `signal/sdp.go:154`

**問題**: `a=rtcp:<RTP_port>` と `a=rtcp-mux` が同時に出力される。

**修正**: `a=rtcp:9 IN IP4 0.0.0.0\r\n` に変更。

---

### I. Keepalive タイムアウト狭すぎ — `signal/session.go:252`

**問題**: sendonly セッションで 30s タイムアウト。consent-refresh 遅延で正常クライアントが切断される。

**修正**: `30 * time.Second` → `45 * time.Second`

---

### J. Request body サイズ制限なし — `cmd/server/main.go:438`

**問題**: `io.ReadAll(r.Body)` に上限なし。大容量 POST で OOM DoS。

**修正**:
```go
r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
```
`http.Server` に `ReadTimeout: 10s`, `WriteTimeout: 10s` を追加。

---

## 検証方法

| PR | 確認内容 |
|----|---------|
| PR 1 | `go test ./internal/signal/...` + 実機で Safari/Chrome 接続確認 |
| PR 2 | `go test -race ./...` + 録画中 `kill -TERM` → `ffprobe` でフレーム数確認 |
| PR 3 | `go test ./internal/signal/...`（lowercase fixture 追加）+ offer/answer ログ確認 |
