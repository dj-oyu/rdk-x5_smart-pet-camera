# H.265 codec パッケージ最適化計画

対象: `processor.go` — WebRTC ストリーミングのホットパス

## 現状スナップショット

- BCE hits: **11** (main=16, PR#169 元版=21)
- テストファイル: なし → **最初に作成が必須**
- ホットパス: `Process()` + `findNextStartCode()` (毎フレーム ~30fps)
- コールドパス: `PrependHeaders()` + `parseNALUnits()` (IDR フレームのみ, 14フレームに1回)

---

## 計測コマンド (ベースライン取得)

```bash
cd src/streaming_server

# BCE: 境界チェックが残っている箇所を数える
go build -gcflags='-d=ssa/check_bce/debug=1' ./internal/codec/ 2>&1 | grep processor.go
go build -gcflags='-d=ssa/check_bce/debug=1' ./internal/codec/ 2>&1 | grep processor.go | wc -l

# NCE: prove パスのデバッグ出力（nilcheck キーワードで抽出）
go build -gcflags='-d=ssa/prove/debug=2' ./internal/codec/ 2>&1 | grep -i nil | grep processor

# インライン展開の確認 (NCE の前提)
go build -gcflags='-m=2' ./internal/codec/ 2>&1 | grep processor.go

# Escape Analysis: ヒープエスケープ箇所を一覧
go build -gcflags='-m' ./internal/codec/ 2>&1 | grep processor.go

# ベンチマーク（テストファイル作成後）
go test -bench=. -benchmem -count=5 ./internal/codec/
```

---

## 最適化候補 (優先順位順)

### Iter 0: テストファイル作成【前提条件・最高優先】

`processor_test.go` を作成し、以下を揃える:

| テスト / ベンチ | 内容 |
|---|---|
| `TestProcessTrail` | trail frame → IsIDR==false |
| `TestProcessIDR` | IDR frame → IsIDR==true, VPS/SPS/PPS がキャッシュされる |
| `TestFindNextStartCode` | table-driven: 空, 3-byte, 4-byte, 連続start code |
| `TestExtractNALType` | 両 start code 長で NAL type が正しく取れる |
| `BenchmarkProcessTrail` | ~50KB trail data, allocs/op = 0 が合格基準 |
| `BenchmarkProcessIDR` | VPS+SPS+PPS 付き IDR frame |
| `BenchmarkFindNextStartCode` | 100KB バッファの直接ベンチ |

これがないと最適化の効果・安全性が測れない。

---

### Iter 1: NCE 確認 + メソッドをパッケージ関数化【中優先】

**問題:** `findNextStartCode` は `*Processor` のメソッドだが、`p` を一切使わない。
メソッドとして呼ぶたびにコンパイラが nil check を挿入する可能性がある。

**修正:**
```go
// 変更前
func (p *Processor) findNextStartCode(data []byte, offset int) int {

// 変更後
func findNextStartCode(data []byte, offset int) int {
```

呼び出し側も `p.findNextStartCode(...)` → `findNextStartCode(...)` に変更。

**期待効果:**
- `findNextStartCode` が `Process()` にインライン展開されやすくなる
- `p` に対する nil check が `findNextStartCode` 内から消える
- BCE: インライン展開されれば prove パスが呼び出し境界を越えて証明できる

**検証:**
```bash
# インライン展開の確認
go build -gcflags='-m=2' ./internal/codec/ 2>&1 | grep findNextStartCode
# "inlining call to findNextStartCode" が出ればOK
```

**リスク:** 低。`findNextStartCode` は `p` のフィールドを一切参照していない。

---

### Iter 2: BCE - `findNextStartCode` ループ再構成【中優先】

**問題 (現状):**
```go
for i := offset; i < len(data)-2; i++ {
    if data[i] == 0x00 && data[i+1] == 0x00 {
        if i+2 < len(data) && data[i+2] == 0x01 { ... }
        if i+3 < len(data) && data[i+2] == 0x00 && data[i+3] == 0x01 { ... }
    }
}
```
- ループ境界 `i < len(data)-2` → `data[i]`, `data[i+1]` は BCE
- 内側の `i+2 < len(data)` ガードにより `data[i+2]` も BCE のはずだが hit が残る
- `data[i+3]` は `i+3 < len(data)` ガードで BCE のはず

**修正案A: ループ境界を `len(data)-3` に変更 + エピローグ**
```go
// 本体: data[i]〜data[i+3] の 4 つが全て BCE される
for i := offset; i < len(data)-3; i++ {
    if data[i] == 0x00 && data[i+1] == 0x00 {
        if data[i+2] == 0x01 {
            return i
        }
        if data[i+2] == 0x00 && data[i+3] == 0x01 {
            return i
        }
    }
}
// エピローグ: 最後の位置 len(data)-3 は 3-byte start code のみ可能
if i := len(data) - 3; len(data) >= 3 && i >= offset &&
    data[i] == 0x00 && data[i+1] == 0x00 && data[i+2] == 0x01 {
    return i
}
return -1
```

**検証手順:**
1. `go build -gcflags='-d=ssa/check_bce/debug=1' ./internal/codec/ 2>&1 | grep findNextStartCode`
2. ベンチマーク before/after 比較

**リスク:** 低。エピローグは専用のテストケースで検証可能。

---

### Iter 3: Escape Analysis - `PrependHeaders` の alloc 削減【中優先・コールドパス】

**問題:**
`PrependHeaders()` → `parseNALUnits()` → NAL 数分の `make([]byte, ...)` が発生。
IDR 検出のためだけに全 NAL の完全コピーを作っている。

**修正: ゼロアロック IDR スキャン関数**
```go
// parseNALUnits の代わりに IDR の有無だけをスキャンする
func containsIDR(data []byte) bool {
    offset := 0
    for offset < len(data) {
        startCodeLen := 0
        if offset+4 <= len(data) && bytes.Equal(data[offset:offset+4], startCode4) {
            startCodeLen = 4
        } else if offset+3 <= len(data) && bytes.Equal(data[offset:offset+3], startCode3) {
            startCodeLen = 3
        } else {
            offset++
            continue
        }
        hdrOff := offset + startCodeLen
        if hdrOff >= len(data) {
            break
        }
        t := extractNALType(data[hdrOff])
        if t == types.NALTypeH265IDRWRADL || t == types.NALTypeH265IDRNLP {
            return true
        }
        next := findNextStartCode(data, hdrOff+1)  // Iter1 でパッケージ関数化済み
        if next == -1 {
            break
        }
        offset = next
    }
    return false
}
```

`PrependHeaders` での利用:
```go
if !containsIDR(data) {
    return data, nil
}
```

**期待効果:**
- IDR フレームの `PrependHeaders`: alloc = O(NAL数) → 1 (出力バッファのみ)
- 非 IDR フレームの `PrependHeaders`: alloc = 0 (早期リターン)

**検証:**
```bash
go test -bench=BenchmarkPrependHeaders -benchmem -count=5 ./internal/codec/
# allocs/op: before = NAL数+1, after = 1
```

**リスク:** 中。新コードパスなので TestPrependHeaders で網羅的に検証する。

---

### Iter 4: SIMD スキャン (`bytes.Index`) — プロファイル確認後【低優先・要計測】

**問題:** `findNextStartCode` の per-byte ループは ARM NEON を使えない。
`bytes.Index` は Go 標準ライブラリで SIMD 最適化済み。

**条件:** プロファイルで `findNextStartCode` が `Process()` 実行時間の > 30% を占める場合のみ実施。

**修正案:**
```go
func findNextStartCode(data []byte, offset int) int {
    if offset >= len(data) {
        return -1
    }
    sub := data[offset:]
    i4 := bytes.Index(sub, startCode4)
    i3 := bytes.Index(sub, startCode3)
    switch {
    case i4 < 0 && i3 < 0:
        return -1
    case i4 < 0:
        return offset + i3
    case i3 < 0:
        return offset + i4
    default:
        if i4 <= i3 {
            return offset + i4
        }
        return offset + i3
    }
}
```

**注意点:**
- 4-byte start code (`00 00 00 01`) は 3-byte pattern (`00 00 01`) にも一致するので、
  両方を検索して小さい方を返す必要がある
- 短いスライス (< 16 bytes) では SIMD の恩恵が出ないのでフレームサイズに注意

**プロファイル取得:**
```bash
go test -bench=BenchmarkProcessTrail -cpuprofile=cpu.prof -count=3 ./internal/codec/
go tool pprof -top cpu.prof
```

**リスク:** 中。2回の `bytes.Index` 呼び出しオーバーヘッドが小フレームで問題になる可能性。
ベンチマークで必ず確認。

---

## 成功基準

| 指標 | 現在 | 目標 |
|---|---|---|
| BCE hits (processor.go) | 11 | **≤ 7** |
| `findNextStartCode` BCE hits | 1 | **0** |
| `BenchmarkProcessTrail` allocs/op | 0 (要確認) | 0 |
| `PrependHeaders` allocs/op (IDR) | NAL数+1 (要確認) | **1** |
| `BenchmarkProcessTrail` ns/op | TBD (要計測) | 退行なし、可能なら -10% |

---

## 実施順序サマリ

```
Iter 0: processor_test.go 作成 → ベースライン数値を取得 (必須前提)
Iter 1: findNextStartCode をパッケージ関数化 → NCE + インライン確認
Iter 2: findNextStartCode ループ境界を len(data)-3 に → BCE hits 削減
Iter 3: containsIDR() で PrependHeaders alloc 削減
Iter 4: (プロファイル要) bytes.Index SIMD スキャン
```

---

_このプランは `codex/evaluate-bounds-checks-in-go-implementation` ブランチで実施する。_
