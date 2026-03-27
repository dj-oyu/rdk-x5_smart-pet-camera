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
import { createCancellable, autoCancelOn, abortable, isCancelled, type Cancellable } from "./cancellable";
import { ensureTF, loadModel, upscaleTiled, enqueue } from "./upscaler";

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

  // --- Cancellable tokens ---
  const fetchCancel = createCancellable();
  const upscaleCancel = createCancellable();

  // --- Disposers ---
  const disposers: (() => void)[] = [];

  // Auto-cancel upscale when panel or viewMode changes
  disposers.push(autoCancelOn(upscaleCancel, () => {
    activePanel.value;
    viewMode.value;
  }));

  // --- Init: fetch detections + preload image ---
  const initSignal = fetchCancel.controller.signal;
  fetchDetections(event.id, initSignal)
    .then(dets => { detections.value = dets; })
    .catch(e => { if (!isCancelled(e)) detections.value = []; })
    .finally(() => { if (!initSignal.aborted) detLoading.value = false; });

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = photoUrl(event.source_filename);
  img.onload = () => { if (!initSignal.aborted) comicImage.value = img; };

  // --- SSE detection events ---
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

  // --- Auto-detect after 3s if no L2 (effect tracks detLoading) ---
  disposers.push(effect(() => {
    if (detLoading.value) return; // wait for initial load
    if (detections.value.some(d => d.det_level >= 2)) return; // already scanned
    const timer = setTimeout(() => {
      scanning.value = true;
      smokeHits.value = [];
      detectNow(event.source_filename);
    }, 3000);
    return () => clearTimeout(timer);
  }));

  // --- Upscale ---
  function upscalePanel(
    idx: number, modelName: string,
    canvasRefs: (HTMLCanvasElement | null)[],
    hdProgressEl: HTMLDivElement | null,
  ): void {
    const ctrl = upscaleCancel.reset();
    const sig = ctrl.signal;
    const isHD = modelName === "general_plus";
    enqueue(async () => {
      try {
        await abortable(ensureTF(), sig, "ensureTF");
        const model = await abortable(loadModel(modelName), sig, `loadModel(${modelName})`);
        if (!comicImage.peek()) return;

        const src = document.createElement("canvas");
        const p = PANELS[idx];
        src.width = p.w; src.height = p.h;
        src.getContext("2d")!.drawImage(comicImage.peek()!, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
        const canvas = canvasRefs[idx];
        if (!canvas) return;

        if (isHD) hdLoading.value = true;
        const completed = await upscaleTiled(src, canvas, model, sig, (d, t) => {
          if (isHD && hdProgressEl) hdProgressEl.style.width = `${(d / t) * 100}%`;
        });
        if (!completed) return; // aborted inside tile loop

        upscaleState.value = { ...upscaleState.peek(), [idx]: isHD ? "hd" : "fast" };
        if (isHD) {
          hdLoading.value = false;
          if (hdProgressEl) hdProgressEl.style.width = "0";
        }
        // Prefetch next panel
        const next = (idx + 1) % 4;
        if (!upscaleState.peek()[next] && !sig.aborted) {
          upscalePanel(next, "general_fast", canvasRefs, hdProgressEl);
        }
      } catch (e) {
        if (isCancelled(e)) return; // expected — panel switched or modal closed
        console.error("upscale error:", e);
      } finally {
        if (isHD) {
          hdLoading.value = false;
          if (hdProgressEl) hdProgressEl.style.width = "0";
        }
      }
    });
  }

  // --- Cleanup ---
  function dispose(): void {
    fetchCancel.abort();
    upscaleCancel.abort();
    setDetectionHandlers(undefined, undefined);
    for (const d of disposers) d();
  }

  return {
    detections, detLoading, smokeHits, scanning,
    hoveredDetId, pinnedDetId, peekMode, activeDetId,
    viewMode, activePanel, zoomedDetId,
    upscaleState, hdLoading,
    editingId, editing, formPetId, formStatus, formBehavior,
    comicImage, copied, visibleDets,
    upscalePanel, dispose, event,
  };
}
