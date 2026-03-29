/**
 * Real-ESRGAN TF.js upscaler — global singleton.
 * Accepts AbortSignal for cancellation. No DOM refs, no signals.
 */

const TILE = 128;
const SCALE = 4;

let tf: any = null;
let backend = "";
const models: Record<string, any> = {};

export async function ensureTF(): Promise<string> {
  if (tf) return backend;
  await import("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js");
  tf = (window as any).tf;
  await tf.ready();
  try {
    await import("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.22.0/dist/tf-backend-webgpu.min.js");
    await tf.setBackend("webgpu");
    await tf.ready();
  } catch { /* webgl fallback */ }
  backend = tf.getBackend();
  return backend;
}

export async function loadModel(name: string): Promise<any> {
  if (models[name]) return models[name];
  const model = await tf.loadLayersModel(`/api/models/tfjs/${name}/model.json`);
  models[name] = model;
  return model;
}

export function getBackend(): string {
  return backend;
}

export type UpscaleProgress = (done: number, total: number) => void;

/**
 * Tiled 4x upscale from srcCanvas to outCanvas.
 * Checks signal.aborted between tiles for cancellation.
 * Returns true if completed, false if aborted.
 */
export async function upscaleTiled(
  srcCanvas: HTMLCanvasElement,
  outCanvas: HTMLCanvasElement,
  model: any,
  signal: AbortSignal,
  onProgress?: UpscaleProgress,
): Promise<boolean> {
  const sw = srcCanvas.width, sh = srcCanvas.height;
  outCanvas.width = sw * SCALE;
  outCanvas.height = sh * SCALE;
  const dCtx = outCanvas.getContext("2d")!;
  const tilesX = Math.ceil(sw / TILE), tilesY = Math.ceil(sh / TILE);
  const total = tilesX * tilesY;
  let done = 0;

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      if (signal.aborted) return false;

      const sx = tx * TILE, sy = ty * TILE;
      const tw = Math.min(TILE, sw - sx), th = Math.min(TILE, sh - sy);

      // Create padded tile
      const tile = document.createElement("canvas");
      tile.width = TILE; tile.height = TILE;
      const tCtx = tile.getContext("2d")!;
      tCtx.drawImage(srcCanvas, sx, sy, tw, th, 0, 0, tw, th);
      if (tw < TILE) tCtx.drawImage(tile, tw - 1, 0, 1, th, tw, 0, TILE - tw, th);
      if (th < TILE) tCtx.drawImage(tile, 0, th - 1, TILE, 1, 0, th, TILE, TILE - th);

      // Inference
      const out = tf.tidy(() => {
        const inp = tf.browser.fromPixels(tile).toFloat().div(255.0).expandDims(0);
        return model.predict(inp);
      });
      const clamped = out.squeeze().clipByValue(0, 1);
      const pixels = await tf.browser.toPixels(clamped);
      clamped.dispose();
      out.dispose();

      // Draw to output
      const cropW = tw * SCALE, cropH = th * SCALE;
      const imgData = new ImageData(new Uint8ClampedArray(pixels.buffer), TILE * SCALE, TILE * SCALE);
      const tmp = document.createElement("canvas");
      tmp.width = TILE * SCALE; tmp.height = TILE * SCALE;
      tmp.getContext("2d")!.putImageData(imgData, 0, 0);
      dCtx.drawImage(tmp, 0, 0, cropW, cropH, sx * SCALE, sy * SCALE, cropW, cropH);

      done++;
      onProgress?.(done, total);
    }
  }
  return true;
}

/** Serialize upscale operations — only one at a time */
let queue = Promise.resolve();
export function enqueue(fn: () => Promise<void>): void {
  queue = queue.then(fn).catch(console.error);
}
