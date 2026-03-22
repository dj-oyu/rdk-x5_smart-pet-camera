# テキスト描画アーキテクチャ設計書

## 概要

4コマ comic キャプションと MJPEG オーバーレイで、日本語テキスト + カラー絵文字を NV12 フレームに描画する。

## 現状の実装

### レンダリングパイプライン

```
[テキスト (UTF-8)]
     ↓
[FreeType C ライブラリ]  ← ft_text.c
  - Noto Sans JP Bold (5.3MB) → 日本語/英数字 (グレースケールグリフ)
  - Noto Color Emoji (24MB) → カラー絵文字 (CBDT/CBLC BGRA ビットマップ)
  - 自動フォールバック: text_font → emoji_font → skip
     ↓
[BGRA ピクセルバッファ]  ← C malloc
     ↓
[Go: BGRA→RGBA 変換]    ← text_renderer.go RenderTextBGRA()
     ↓
[image.RGBA キャッシュ]   ← 検出変更時のみレンダリング (MJPEG overlay)
     ↓
[blendRGBAOnNV12()]      ← RGBA→YUV 変換 + アルファブレンド
     ↓
[NV12 フレーム]           ← MJPEG/comic に直接書き込み
```

### 利用箇所

| 用途 | 頻度 | 関数 |
|------|------|------|
| 4コマ comic キャプション | 撮影時 1 回 | `DrawCaptionOnNV12()` |
| MJPEG 検出ラベル | 検出変更時のみレンダリング、毎フレームブレンド | `RenderLabel()` + `blendRGBAOnNV12()` |
| MJPEG タイムスタンプ | 毎フレーム | C bitmap (変更なし、ASCII のみで十分) |

### パフォーマンス (CPU)

| 処理 | コスト | 頻度 |
|------|--------|------|
| FreeType レンダリング (5ラベル) | ~1ms | 検出変更時のみ (~10fps) |
| BGRA→RGBA 変換 | ~0.05ms | 検出変更時のみ |
| NV12 アルファブレンド (5ラベル) | ~0.2ms | 毎フレーム (30fps) |
| **合計** | **~0.2ms/frame avg** | — |

## HW アクセラレーション調査 (2026-03-22 実機検証済み)

### 調査対象: BGRA→NV12 変換の GPU オフロード

現在の `blendRGBAOnNV12()` は CPU でピクセル単位の YUV 変換 + アルファブレンドを行う。
nano2D (GC820 GPU 2D エンジン) でオフロードできるか実機検証した。

### nano2D API 能力確認

| 機能 | サポート | 確認方法 |
|------|---------|---------|
| `N2D_BGRA8888` 入力 | OK | `nano2D_enum.h` + SDK サンプル |
| `N2D_NV12` 出力 | OK | `sample_format_convert` |
| `N2D_BLEND_SRC_OVER` alpha blend | OK | `sample_alphablend` (同一フォーマット間) |
| BGRA→NV12 フォーマット変換 (`BLEND_NONE`) | OK | `sample_format_convert` |
| **BGRA→NV12 alpha blend (`SRC_OVER`)** | **NG** | 実機テストで error 7 |

### 実機検証結果

検証コード: `gpu_investigation/n2d_alpha_blend_test.c`

**Test 1: 直接パス** — `n2d_blit(nv12_dst, bgra_src, N2D_BLEND_SRC_OVER)`
- 結果: **FAIL** (error 7)
- nano2D は CSC (色空間変換) と alpha blending を同時実行できない

**Test 2: 2段階パス** — NV12→BGRA 抽出 → BGRA alpha blend → BGRA→NV12 書き戻し
- 結果: **PASS**
- 性能: 5ラベル合成 = **0.473 ms/iter** (3 blit/label + 1 commit)

### 性能比較

| 方式 | 5ラベル/frame | CPU 負荷 |
|------|-------------|---------|
| 現行 CPU (`blendRGBAOnNV12`) | **0.2ms** | 0.2ms |
| GPU 2段階パス | 0.473ms | ~0ms (GPU のみ) |

### 結論: 現行 CPU 実装を維持

- GPU 2段階パス (0.473ms) は CPU 実装 (0.2ms) より **2.4x 遅い**
- GPU パスは CPU を解放するが、元々 0.2ms と軽く恩恵が薄い
- `hw-offload-roadmap.md` の判断「低負荷、変更なし」が正しい

将来オーバーレイ数が増加した場合は **NEON SIMD で CPU パスを最適化** (RGB→YUV + alpha blend を 4px 同時処理) が有効。

### 参考: 他の HW パス

| HW | BGRA→NV12 blend 可否 | 備考 |
|----|---------------------|------|
| VPU JPEG エンコーダ | 不可 | NV12 入力のみ |
| VSE | 不可 | NV12→NV12 スケーリング専用 |
| DSP/BPU | 不可 | 推論専用 |

## フォント

| ファイル | サイズ | ライセンス | 用途 |
|---------|-------|-----------|------|
| `assets/fonts/NotoSansJP-Bold.ttf` | 5.3MB | SIL OFL | 日本語+英数字 |
| `assets/fonts/NotoColorEmoji-Regular.ttf` | 24MB | SIL OFL | カラー絵文字 (CBDT) |
| `assets/fonts/OFL.txt` | — | — | ライセンスファイル |

## 依存ライブラリ

| ライブラリ | バージョン (RDK X5) | 用途 |
|-----------|-------------------|------|
| FreeType | 2.11.1 | フォントレンダリング (text + CBDT emoji) |
| HarfBuzz | 2.7.4 | テキストシェーピング (将来: 複合絵文字、リガチャ) |

`libharfbuzz-dev` は未インストール。HarfBuzz 統合が必要になった場合:
```bash
apt install libharfbuzz-dev
```

## ソースファイル

| ファイル | 言語 | 役割 |
|---------|------|------|
| `src/streaming_server/internal/webmonitor/ft_text.h` | C | FreeType レンダラー API |
| `src/streaming_server/internal/webmonitor/ft_text.c` | C | FreeType 実装 (UTF-8 デコード、グリフ描画、BGRA 出力) |
| `src/streaming_server/internal/webmonitor/text_renderer.go` | Go | CGO バインディング + NV12 ブレンド |
| `src/streaming_server/internal/webmonitor/broadcaster.go` | Go | MJPEG オーバーレイ統合 (キャッシュ付き TrueType ラベル) |
| `src/streaming_server/internal/webmonitor/comic_capture.go` | Go | 4コマ キャプション描画 |

## 将来の拡張

- [ ] HarfBuzz 統合: 複合絵文字 (👨‍👩‍👧‍👦)、肌色バリエーション、リガチャ
- [x] ~~nano2D GPU による BGRA→NV12 アルファブレンド HW オフロード~~ → 検証の結果 CPU 実装維持 (GPU 2段階パスは 2.4x 遅い)
- [ ] VLM キャプション自動生成 → テキストレンダラーで描画
- [ ] MJPEG タイムスタンプも TrueType 化 (現在は C bitmap で十分)
- [ ] フォントサブセット化 (5.3MB → ~1MB: 使用グリフのみ抽出)
