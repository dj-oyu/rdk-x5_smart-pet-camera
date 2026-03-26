import { signal, computed, effect } from "@preact/signals";
import {
  fetchDetections,
  detectNow,
  photoUrl,
  type Detection,
  type PartialDetection,
  type EventSummary,
} from "./api";
import { setDetectionHandlers } from "./sse";

// Panel layout constants
const MARGIN = 12, BORDER = 2, GAP = 8, PW = 404, PH = 228;
const CELL_W = PW + 2 * BORDER, CELL_H = PH + 2 * BORDER;
export const PANELS = [0, 1, 2, 3].map(i => {
  const col = i % 2, row = Math.floor(i / 2);
  return {
    x: MARGIN + BORDER + col * (CELL_W + GAP),
    y: MARGIN + BORDER + row * (CELL_H + GAP),
    w: PW, h: PH,
  };
});
export { PW, PH };

export type ViewMode = "comic" | "panel";

export function panelOf(det: { bbox_x: number; bbox_y: number; bbox_w: number; bbox_h: number }): number {
  const cx = det.bbox_x + det.bbox_w / 2;
  const cy = det.bbox_y + det.bbox_h / 2;
  return PANELS.findIndex(p => cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h);
}

export function detsForPanel(dets: Detection[], idx: number): Detection[] {
  return dets.filter(d => panelOf(d) === idx);
}

const PRIMARY_CLASSES = new Set(["cat", "dog", "bird", "food_bowl", "water_bowl", "person"]);
export function classTier(det: Detection): "high" | "low" {
  return PRIMARY_CLASSES.has(det.yolo_class ?? "") ? "high" : "low";
}

export const CLASS_COLORS: Record<string, string> = {
  cat: "#6EFF9E", dog: "#FFC878", bird: "#A0DCFF",
  food_bowl: "#78C8FF", water_bowl: "#FF8C8C",
  person: "#FFF08C", cup: "#FFBED2",
};

export function bboxColor(det: Detection): string {
  return CLASS_COLORS[det.yolo_class ?? ""] ?? "#94a3b8";
}

export type DetailStore = ReturnType<typeof createDetailStore>;

export function createDetailStore(event: EventSummary, initPanel: number | null) {
  // --- Signals ---
  const detections = signal<Detection[]>([]);
  const detLoading = signal(true);
  const smokeHits = signal<PartialDetection[]>([]);
  const scanning = signal(false);

  const hoveredDetId = signal<number | null>(null);
  const pinnedDetId = signal<number | null>(null);
  const peekMode = signal(false);
  const activeDetId = computed(() => pinnedDetId.value ?? hoveredDetId.value);

  const viewMode = signal<ViewMode>(initPanel != null ? "panel" : "comic");
  const activePanel = signal(initPanel ?? 0);
  const zoomedDetId = signal<number | null>(null);

  const upscaleState = signal<Record<number, "raw" | "fast" | "hd">>({});
  const hdLoading = signal(false);

  const editingId = signal<number | null>(null);
  const editing = signal(false);
  const formPetId = signal(event.pet_id);
  const formStatus = signal(event.status);
  const formBehavior = signal(event.behavior);

  const comicImage = signal<HTMLImageElement | null>(null);
  const copied = signal(false);

  const visibleDets = computed(() =>
    viewMode.value === "comic"
      ? detections.value
      : detsForPanel(detections.value, activePanel.value)
  );

  // --- TF.js refs (not reactive) ---
  const tfState = {
    tf: null as any,
    backend: "",
    models: {} as Record<string, any>,
    cancel: 0,
    queue: Promise.resolve(),
  };

  // --- Disposers ---
  const disposers: (() => void)[] = [];

  // --- Effect A: fetch detections + preload image ---
  let fetchCancelled = false;
  fetchDetections(event.id)
    .then(dets => { if (!fetchCancelled) detections.value = dets; })
    .catch(() => { if (!fetchCancelled) detections.value = []; })
    .finally(() => { if (!fetchCancelled) detLoading.value = false; });

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = photoUrl(event.source_filename);
  img.onload = () => { if (!fetchCancelled) comicImage.value = img; };

  // --- Effect B: SSE detection events ---
  setDetectionHandlers(
    (data) => {
      if (data.filename === event.source_filename) {
        smokeHits.value = [...smokeHits.value, data];
      }
    },
    (data) => {
      if (data.filename === event.source_filename) {
        scanning.value = false;
        smokeHits.value = [];
        fetchDetections(event.id).then(d => { detections.value = d; }).catch(() => {});
      }
    },
  );

  // --- Effect C: auto-detect after 3s if no L2 ---
  const detectTimer = setTimeout(() => {
    if (detLoading.value) return; // still loading, skip
    const hasL2 = detections.peek().some(d => d.det_level >= 2);
    if (!hasL2) {
      scanning.value = true;
      smokeHits.value = [];
      detectNow(event.source_filename);
    }
  }, 3000);

  // Also set up an effect for when loading completes after timer
  const autoDetectDisposer = effect(() => {
    if (detLoading.value) return;
    // Check once after detections loaded — if timer already fired, this is a no-op
  });
  disposers.push(autoDetectDisposer);

  // --- Upscale functions ---
  async function ensureTF(): Promise<boolean> {
    if (tfState.tf) return true;
    try {
      await import("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js");
      tfState.tf = (window as any).tf;
      await tfState.tf.ready();
      try {
        await import("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.22.0/dist/tf-backend-webgpu.min.js");
        await tfState.tf.setBackend("webgpu");
        await tfState.tf.ready();
      } catch { /* webgl fallback */ }
      tfState.backend = tfState.tf.getBackend();
      return true;
    } catch { return false; }
  }

  async function loadModel(name: string) {
    if (tfState.models[name]) return tfState.models[name];
    const model = await tfState.tf.loadGraphModel(`/api/models/tfjs/${name}/model.json`);
    tfState.models[name] = model;
    return model;
  }

  const TILE = 128, SCALE = 4;

  async function upscaleToCanvas(
    srcCanvas: HTMLCanvasElement, outCanvas: HTMLCanvasElement,
    model: any, onProgress: ((d: number, t: number) => void) | null, token: number,
  ): Promise<boolean> {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    outCanvas.width = sw * SCALE; outCanvas.height = sh * SCALE;
    const dCtx = outCanvas.getContext("2d")!;
    const tilesX = Math.ceil(sw / TILE), tilesY = Math.ceil(sh / TILE);
    const tot = tilesX * tilesY;
    let done = 0;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        if (token !== tfState.cancel) return false;
        const sx = tx * TILE, sy = ty * TILE;
        const tw = Math.min(TILE, sw - sx), th = Math.min(TILE, sh - sy);
        const tile = document.createElement("canvas");
        tile.width = TILE; tile.height = TILE;
        const tCtx = tile.getContext("2d")!;
        tCtx.drawImage(srcCanvas, sx, sy, tw, th, 0, 0, tw, th);
        if (tw < TILE) tCtx.drawImage(tile, tw - 1, 0, 1, th, tw, 0, TILE - tw, th);
        if (th < TILE) tCtx.drawImage(tile, 0, th - 1, TILE, 1, 0, th, TILE, TILE - th);
        const out = tfState.tf.tidy(() => {
          const inp = tfState.tf.browser.fromPixels(tile).toFloat().div(255.0).expandDims(0);
          return model.predict(inp);
        });
        const clamped = out.squeeze().clipByValue(0, 1);
        const pixels = await tfState.tf.browser.toPixels(clamped);
        clamped.dispose(); out.dispose();
        const cropW = tw * SCALE, cropH = th * SCALE;
        const imgData = new ImageData(new Uint8ClampedArray(pixels.buffer), TILE * SCALE, TILE * SCALE);
        const tmp = document.createElement("canvas");
        tmp.width = TILE * SCALE; tmp.height = TILE * SCALE;
        tmp.getContext("2d")!.putImageData(imgData, 0, 0);
        dCtx.drawImage(tmp, 0, 0, cropW, cropH, sx * SCALE, sy * SCALE, cropW, cropH);
        done++;
        onProgress?.(done, tot);
      }
    }
    return true;
  }

  function upscalePanel(
    idx: number, modelName: string,
    canvasRefs: (HTMLCanvasElement | null)[],
    hdProgressEl: HTMLDivElement | null,
  ): void {
    const token = ++tfState.cancel;
    const job = async () => {
      try {
        if (token !== tfState.cancel) return;
        if (!await ensureTF()) return;
        if (token !== tfState.cancel || !comicImage.peek()) return;
        const model = await loadModel(modelName);
        if (token !== tfState.cancel) return;
        const src = document.createElement("canvas");
        const p = PANELS[idx];
        src.width = p.w; src.height = p.h;
        src.getContext("2d")!.drawImage(comicImage.peek()!, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
        const canvas = canvasRefs[idx];
        if (!canvas) return;
        if (modelName === "general_plus") hdLoading.value = true;
        const completed = await upscaleToCanvas(src, canvas, model, (d, t) => {
          if (modelName === "general_plus" && hdProgressEl) {
            hdProgressEl.style.width = `${(d / t) * 100}%`;
          }
        }, token);
        if (!completed || token !== tfState.cancel) return;
        const level = modelName === "general_plus" ? "hd" as const : "fast" as const;
        upscaleState.value = { ...upscaleState.peek(), [idx]: level };
        if (modelName === "general_plus") {
          hdLoading.value = false;
          if (hdProgressEl) hdProgressEl.style.width = "0";
        }
        // Prefetch next
        const next = (idx + 1) % 4;
        if (!upscaleState.peek()[next] && token === tfState.cancel) {
          upscalePanel(next, "general_fast", canvasRefs, hdProgressEl);
        }
      } catch (e) {
        console.error("upscale error:", e);
        hdLoading.value = false;
        if (hdProgressEl) hdProgressEl.style.width = "0";
      }
    };
    tfState.queue = tfState.queue.then(job);
  }

  // --- Cleanup ---
  function dispose(): void {
    fetchCancelled = true;
    clearTimeout(detectTimer);
    ++tfState.cancel; // cancel any in-flight upscale
    setDetectionHandlers(undefined, undefined);
    for (const d of disposers) d();
  }

  return {
    // Signals
    detections, detLoading, smokeHits, scanning,
    hoveredDetId, pinnedDetId, peekMode, activeDetId,
    viewMode, activePanel, zoomedDetId,
    upscaleState, hdLoading,
    editingId, editing, formPetId, formStatus, formBehavior,
    comicImage, copied, visibleDets,
    // Actions
    upscalePanel,
    dispose,
    // Constants
    event,
  };
}
