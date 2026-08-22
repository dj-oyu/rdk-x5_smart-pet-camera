# OP-TEE AF_ALG 実装知見 — RDK X5 TE ドライバの挙動と制約

## 背景

streaming-server の SRTP 暗号化 (AES-128-CTR + HMAC-SHA1) を OP-TEE ハードウェア暗号エンジンへオフロードする過程で、TE ドライバの複数の非標準挙動を発見した。本ドキュメントは発見した issue、ワークアラウンド、およびパフォーマンス特性を記録する。

**環境**:
- SoC: RDK X5 (ARM Cortex-A55, ARMv8 暗号拡張命令なし)
- Kernel crypto driver: `ecb-aes-te`, `hmac-sha1-te` (priority=400, OP-TEE TrustZone)
- AF_ALG ソケット経由でユーザー空間からアクセス
- Go 1.26.2 linux/arm64

---

## Issue 1: `accept4` に non-NULL addr を渡すと ECONNABORTED

### 症状

Go の `syscall.Accept()` が AF_ALG skcipher ソケットで `ECONNABORTED` を返す。Python の `socket.accept()` は同じソケットで成功する。

### 原因

Go の `syscall.Accept()` は内部で `accept4(fd, &rsa, [112], 0)` を呼ぶ。112 バイトの `RawSockaddrAny` バッファを渡す。AF_ALG にはピアアドレスの概念がなく、TE ドライバは non-NULL addr 引数を受け付けない。

```
// 失敗: Go の syscall.Accept
accept4(3, 0x8f1a0528b9c, [112], 0) = -1 ECONNABORTED

// 成功: NULL addr を渡す
accept4(3, NULL, NULL, 0)            = 4
```

Python は内部で `accept(fd, NULL, NULL)` を呼ぶため問題が発生しない。

### ワークアラウンド

`accept4(fd, NULL, NULL, SOCK_CLOEXEC)` を raw syscall で直接呼ぶヘルパー関数を使用:

```go
func afalgAccept(fd int) (int, error) {
    opfd, _, errno := syscall.Syscall6(syscall.SYS_ACCEPT4,
        uintptr(fd), 0, 0, uintptr(syscall.SOCK_CLOEXEC), 0, 0)
    if errno != 0 {
        return -1, errno
    }
    return int(opfd), nil
}
```

### 影響範囲

AF_ALG を使う全ての Go コード (skcipher, hash 両方)。Go の標準 `syscall.Accept` は AF_ALG では使用不可。

---

## Issue 2: ECB skcipher の encrypt/decrypt が逆

### 症状

`skcipher/ecb(aes)` に plain `write()` でデータを送り `read()` で結果を得ると、AES encrypt ではなく **AES decrypt** が実行される。`sendmsg` で `ALG_SET_OP = ALG_OP_ENCRYPT (0)` を明示しても同様。

### 検証

NIST AES-128 ECB テストベクター:
- Key: `2B7E151628AED2A6ABF7158809CF4F3C`
- Plaintext: `6BC1BEE22E409F96E93D7E117393172A`
- Expected ciphertext: `3AD77BB40D7A3660A89ECAF32466EF97`

```
ALG_OP_ENCRYPT (0) → plaintext入力 → 500594e2... (decrypt結果)
ALG_OP_DECRYPT (1) → plaintext入力 → 3AD77BB4... (正しい encrypt結果!)
```

### 原因

`ecb-aes-te` ドライバが `ALG_OP_ENCRYPT` と `ALG_OP_DECRYPT` を逆に実装している。

### ワークアラウンド

`sendmsg` の cmsg で `ALG_OP_DECRYPT (1)` を指定することで AES encrypt を実行:

```go
const algOpActualEncrypt = 1 // kernel "DECRYPT" = TE driver encrypt

var afalgEncryptOOB = func() []byte {
    // ... cmsg with ALG_SET_OP = algOpActualEncrypt
}()

// sendmsg + read (not write + read)
syscall.Sendmsg(opFD, plaintext, afalgEncryptOOB, nil, 0)
syscall.Read(opFD, ciphertext)
```

### 影響範囲

AF_ALG skcipher を使う全てのコード。plain `write()`/`read()` はデフォルトで decrypt を実行するため、必ず `sendmsg` + cmsg で方向を明示する必要がある。

---

## Issue 3: hash ドライバの incremental `write()` が無視される

### 症状

`hash/hmac(sha1)` に対して複数回の `write()` でデータを送ると、最後の `read()` で常に**空データの HMAC** が返る。Write syscall 自体は成功 (n > 0) を返すが、ハッシュ計算にデータが反映されない。

```
write(6, data_28bytes, 28) = 28   // 成功
write(6, roc_4bytes, 4)    = 4    // 成功
read(6, digest, 20)        = 20   // HMAC("") が返る ← 28+4 バイトが無視された
```

### 原因

`hmac-sha1-te` ドライバは `write(2)` による incremental hashing をサポートしていない。`write()` はカーネルの `hash_sendmsg` を呼ぶが、TE ドライバはこの経路でのデータ蓄積を正しく処理できない。

### ワークアラウンド

`sendmsg` の `MSG_MORE` フラグを使用して incremental hashing を実現:

```go
// 中間データ: MSG_MORE で「まだ続きがある」ことを通知
syscall.Sendmsg(opFD, partialData, nil, nil, syscall.MSG_MORE)

// 最終データ: MSG_MORE なしで finalize
syscall.Sendmsg(opFD, nil, nil, nil, 0)

// ダイジェスト取得
syscall.Read(opFD, digest)
```

単一の `write()` でデータを全て送る場合は正しく動作する。問題は複数回の `write()` にのみ発生する。

### 影響範囲

AF_ALG hash を使う全てのコード。Go の `hash.Hash` インターフェースは `Write` を複数回呼ぶことを前提とするため、`sendmsg(MSG_MORE)` への置き換えが必須。

---

## パフォーマンス特性

### ベンチマーク (SRTP 1200 byte パケット, 2 クライアント)

| 構成 | CPU (`top` 1core) | CPU (`ps` 累積平均) | pprof 内訳 |
|------|-------------------|-------------------|-----------|
| pion/srtp ソフトウェア (元) | ~200%+ | ~52% | AES 33%, SHA1 22%, UDP 16% |
| 自前 SRTP ソフトウェア | ~90% | ~10% | AES 35%, SHA1 20%, UDP 18% |
| 自前 SRTP + AF_ALG (AES+HMAC) | ~180% | ~47% | **Syscall6 75%**, sendmsg 35% |

※ `top` は 1 core 上のリアルタイムピーク (バースト送信中)。`ps` は全コア平均の累積値。

### 分析

AF_ALG 経由の TE ドライバは**パケット単位の高頻度暗号化には不適**:

1. **syscall オーバーヘッド**: 1 パケットあたり ~6 syscall (ECB: sendmsg + read, HMAC: sendmsg x2 + sendmsg + read, close + accept)
2. **コンテキストスイッチ**: 各 AF_ALG syscall が Normal World → Secure World (TrustZone) 遷移を含む
3. **小データ不利**: 1200 byte パケットでは TE セットアップコストがデータ処理コストを大幅に上回る

```
SW AES-CTR:  75 block.Encrypt() = 75 Go関数呼び出し (ゼロ syscall)
AF_ALG ECB:  1 sendmsg + 1 read = 2 syscall + 2 TE context switch
→ syscall + TE遷移コスト ≫ 75 Go関数呼び出しコスト
```

### TE ドライバが有効なケース (推定)

| ユースケース | データサイズ | 有効性 |
|-------------|------------|--------|
| SRTP パケット暗号化 (1200B) | 小 | **不適** — syscall overhead 支配的 |
| ファイル暗号化 (MB) | 大 | 有効 — TE セットアップコスト償却可能 |
| TLS bulk encryption | 中~大 | 有効 — カーネル内で直接使用、AF_ALG 不要 |
| ストレージ暗号化 | 大 | 有効 — ブロックデバイスレイヤーで使用 |

---

## 実装ステータス

### 完成したもの

- `internal/srtp/afalg.go`: 上記3つの issue 全てのワークアラウンドを実装
- `internal/srtp/cipher.go`: AF_ALG batch ECB + sendmsg(MSG_MORE) HMAC
- `internal/srtp/srtp_test.go`: NIST テストベクター、pion 統合テスト、AF_ALG vs ソフトウェア一致テスト (100 パケット)
- AF_ALG ↔ ソフトウェアの自動フォールバック (AF_ALG 非対応環境ではソフトウェアに自動切替)

### 現在の構成 (production)

AF_ALG 実装は正確に動作するが、パフォーマンス特性により production ではソフトウェア暗号を使用:

```
AES-CTR:  AF_ALG batch ECB (sendmsg + read) — 正常動作するが syscall overhead 大
HMAC:     AF_ALG hmac(sha1) (sendmsg MSG_MORE + read) — 正常動作するが syscall overhead 大
KDF:      Go crypto/aes (ソフトウェア) — cold path、セッション開始時のみ
```

---

## 教訓と推奨事項

### TE ドライバの品質

OP-TEE の AF_ALG ドライバは標準 Linux Crypto API の規約から逸脱している点が多い:

1. `accept4` の addr 引数処理
2. skcipher の encrypt/decrypt 方向
3. hash の `write()` incremental hashing

**推奨**: TE ドライバを使用する場合、NIST テストベクターによる動作検証を必ず実施すること。カーネルの selftest (`selftest: passed`) は通過しているが、ユーザー空間 AF_ALG 経由のテストは不十分。

### AF_ALG の Go での使用

Go の `syscall` パッケージは AF_ALG を想定していない:

- `syscall.Accept`: non-NULL addr → ECONNABORTED
- `syscall.Recvmsg`: `anyToSockaddr` が AF_ALG family を解析できない

**推奨**: AF_ALG 操作には raw syscall (`Syscall6`) または `Sendmsg`/`Read` の組み合わせを使用。`Accept`/`Recvmsg` は避ける。

### パフォーマンスの事前評価

AF_ALG ベンチマーク (isolated) で 7.7x 高速という結果は、syscall overhead を過小評価していた。Production 環境では:

- 1 パケットあたりの syscall 数が 6+ (accept, sendmsg, read, sendmsg x2, read)
- 各 syscall が TE context switch を含む
- 合計 overhead > ソフトウェア暗号の CPU コスト

**推奨**: HW オフロードのベンチマークは isolated operation ではなく、実際の使用パターン (per-packet、高頻度) でプロファイルすること。
