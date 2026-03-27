# SPEC: Real-ESRGAN Client-Side Upscale

## Overview

ブラウザ上で TensorFlow.js を使い、パネル画像 (404x228) を 4x 拡大 (1616x912) する。
`/test/carousel` デモで実証済み。本番ポート時の設計仕様。

## Models

| Model | Size | Quality | Speed (iPhone 15) | Use |
|-------|------|---------|-------------------|-----|
| `general_fast` | 2.4MB | Good | ~700ms | パネル表示時に自動実行 |
| `general_plus` | 33MB | Best | ~900ms (cached) | HD ボタンで明示的に実行 |

- 形式: TF.js GraphModel (SavedModel → TFJS 変換)
- 量子化: INT8 (uint8)
- 出力: 4x 拡大画像

## Architecture

```
Browser
  ├── TF.js Backend: WebGPU (preferred) → WebGL (fallback)
  ├── Model Cache: Map<string, tf.GraphModel> (メモリ内)
  └── Upscale Queue: シリアライズされた Promise chain

Server
  └── GET /api/models/tfjs/{model_name}/{file}
      ├── model.json (グラフ定義)
      └── group1-shard*.bin (重みファイル)
```

## Processing Pipeline

```
Input (404×228 canvas)
  → Normalize to [0,1] float32
  → Tile into 128×128 patches (overlap 8px)
  → For each tile:
      → tf.tidy(() => model.predict(tile))
      → Output: 512×512 (4x)
  → Stitch tiles back together
  → Clip to [0,1]
  → tf.browser.toPixels()
  → Draw on output canvas (1616×912)
```

### Tiling Strategy

大きな入力を一度に処理するとVRAMオーバーフローするため、128px タイルに分割:

- **Tile size**: 128×128 px
- **Extension**: 8px (タイル境界のアーティファクトを防ぐ)
- **Output tile**: 512×512 px (4x)
- **Stitching**: extension 部分を除去して結合

## Cancel Token

モバイルで連続スワイプ時に古い upscale を中断するため、cancel token パターンを使用:

```javascript
let cancelToken = { cancelled: false };

function upscalePanel(idx, modelName) {
  cancelToken.cancelled = true;           // 前回のタスクをキャンセル
  cancelToken = { cancelled: false };     // 新しいトークン
  const token = cancelToken;

  return enqueueUpscale(async () => {
    if (token.cancelled) return;
    const model = await loadModel(modelName);
    if (token.cancelled) return;
    // ... tile processing, check token between tiles
  });
}
```

## Upscale Queue

NPU/GPU の排他アクセス（特にモバイル）のため、同時に1つだけ実行:

```javascript
let upscalePromise = Promise.resolve();

function enqueueUpscale(fn) {
  upscalePromise = upscalePromise.then(fn).catch(console.error);
  return upscalePromise;
}
```

## Production Considerations

### Model Storage

| Option | Pros | Cons |
|--------|------|------|
| `/data/esrgan-models/` (ディスク) | 永続化、起動時ダウンロード不要 | 32GB eMMC の容量制約 |
| GitHub Actions artifact 同梱 | デプロイと一体 | バイナリサイズ +35MB |
| CDN (jsDelivr/unpkg) | ディスク不要 | オフライン不可、Tailscale環境で外部接続必要 |

**推奨**: `/data/esrgan-models/` にダウンロード済みを配置。既存のサーバーハンドラでserve。

### Preact Hook: `useUpscaler`

```typescript
function useUpscaler() {
  const [backend, setBackend] = useState<string>("detecting...");
  const [state, setState] = useState<Record<number, "raw"|"fast"|"hd">>({});
  const modelCache = useRef(new Map<string, tf.GraphModel>());
  const cancelRef = useRef({ cancelled: false });

  async function upscale(panelIdx: number, model: "general_fast"|"general_plus") {
    cancelRef.current.cancelled = true;
    cancelRef.current = { cancelled: false };
    // ... enqueue, load model, tile, render
    setState(prev => ({ ...prev, [panelIdx]: model === "general_plus" ? "hd" : "fast" }));
  }

  return { backend, state, upscale };
}
```

### Memory Budget

- `general_fast` モデル: ~5MB GPU メモリ
- `general_plus` モデル: ~65MB GPU メモリ
- 中間テンソル (per tile): ~8MB
- 出力キャンバス (4枚): 1616×912×4 bytes × 4 = ~24MB

合計: ~100MB (general_plus 使用時)。モバイルSafari のメモリ制限 (512MB-1GB) 内。

### Bbox Re-render

Upscale 後、キャンバスサイズが 404→1616 に変わるため、bbox の座標変換が変わる:

```javascript
const mult = canvas.width > PW ? 4 : 1;  // PW=404
// bbox position = localCoord * mult * (displaySize / canvasSize)
```

Upscale 完了後に `renderBboxes(panelIdx)` を再呼び出しする。
