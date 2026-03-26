import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "preact/hooks";
import {
  fetchDetections,
  detectNow,
  updateDetectionOverride,
  updatePhotoFields,
  photoUrl,
  type Detection,
  type PartialDetection,
  type EventSummary,
  type PetNames,
} from "../lib/api";

const COMIC_W = 848;
const COMIC_H = 496;

// Panel layout constants (must match comic image layout)
const MARGIN = 12, BORDER = 2, GAP = 8, PW = 404, PH = 228;
const CELL_W = PW + 2 * BORDER, CELL_H = PH + 2 * BORDER;
const PANELS = [0, 1, 2, 3].map(i => {
  const col = i % 2, row = Math.floor(i / 2);
  return {
    x: MARGIN + BORDER + col * (CELL_W + GAP),
    y: MARGIN + BORDER + row * (CELL_H + GAP),
    w: PW, h: PH,
  };
});

const PET_OPTIONS = ["mike", "chatora", "other"];
const BEHAVIOR_OPTIONS = [
  "eating", "drinking", "sleeping", "playing", "resting", "moving", "grooming", "other",
];

const CLASS_COLORS: Record<string, string> = {
  cat: "#6EFF9E",
  dog: "#FFC878",
  bird: "#A0DCFF",
  food_bowl: "#78C8FF",
  water_bowl: "#FF8C8C",
  person: "#FFF08C",
  cup: "#FFBED2",
};

function bboxColor(det: Detection): string {
  return CLASS_COLORS[det.yolo_class ?? ""] ?? "#94a3b8";
}

const PRIMARY_CLASSES = new Set(["cat", "dog", "bird", "food_bowl", "water_bowl", "person"]);

function classTier(det: Detection): "high" | "low" {
  return PRIMARY_CLASSES.has(det.yolo_class ?? "") ? "high" : "low";
}

function panelOf(det: Detection): number {
  const cx = det.bbox_x + det.bbox_w / 2;
  const cy = det.bbox_y + det.bbox_h / 2;
  return PANELS.findIndex(p => cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h);
}

function detsForPanel(dets: Detection[], idx: number): Detection[] {
  return dets.filter(d => panelOf(d) === idx);
}

function petDisplay(id: string | null, petNames: PetNames): string {
  if (!id) return "unknown";
  return petNames[id] ?? id;
}

type ViewMode = "comic" | "panel";

type Props = {
  event: EventSummary;
  petNames: PetNames;
  onClose: () => void;
  onUpdated?: (patch: Partial<EventSummary>) => void;
  initialPanel?: number | null;
};

function useContainerScale(ref: preact.RefObject<HTMLDivElement | null>) {
  const [layout, setLayout] = useState({ scale: 1, offsetX: 0, offsetY: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const scale = Math.min(w / COMIC_W, h / COMIC_H);
      setLayout({
        scale,
        offsetX: (w - COMIC_W * scale) / 2,
        offsetY: (h - COMIC_H * scale) / 2,
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return layout;
}

export function EventDetail({ event, petNames, onClose, onUpdated, initialPanel }: Props) {
  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [smokeHits, setSmokeHits] = useState<PartialDetection[]>([]);
  const [scanning, setScanning] = useState(false);
  const [hoveredDetId, setHoveredDetId] = useState<number | null>(null);
  const [pinnedDetId, setPinnedDetId] = useState<number | null>(null);
  const [peekMode, setPeekMode] = useState(false);
  const activeDetId = pinnedDetId ?? hoveredDetId;

  // Carousel state
  const [viewMode, setViewMode] = useState<ViewMode>(initialPanel != null ? "panel" : "comic");
  const [activePanel, setActivePanel] = useState(initialPanel ?? 0);
  const carouselRef = useRef<HTMLDivElement | null>(null);

  // Zoom/pan state
  const [zoomedDetId, setZoomedDetId] = useState<number | null>(null);
  const zoomRef = useRef({ tx: 0, ty: 0, zoom: 1, panelIdx: -1, viewW: 0, viewH: 0, contentW: 0, contentH: 0 });
  const dragRef = useRef<{ startX: number; startY: number; startTx: number; startTy: number; wrapper: HTMLElement } | null>(null);
  const wrapperRefs = useRef<(HTMLDivElement | null)[]>([null, null, null, null]);

  // Edit form state
  const [editing, setEditing] = useState(false);
  const [petId, setPetId] = useState(event.pet_id);
  const [status, setStatus] = useState(event.status);
  const [behavior, setBehavior] = useState(event.behavior);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const { scale, offsetX, offsetY } = useContainerScale(containerRef);

  // Panel canvases refs
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([null, null, null, null]);
  // Preloaded comic image for panel crop
  const [comicImage, setComicImage] = useState<HTMLImageElement | null>(null);

  // Load existing detections + preload image
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setComicImage(null);
    fetchDetections(event.id)
      .then((dets) => { if (!cancelled) setDetections(dets); })
      .catch(() => { if (!cancelled) setDetections([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = photoUrl(event.source_filename);
    img.onload = () => { if (!cancelled) setComicImage(img); };
    return () => { cancelled = true; };
  }, [event.id]);

  // SSE: listen for progressive detection events
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("detection-partial", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as PartialDetection;
      if (data.filename === event.source_filename) {
        setSmokeHits((prev) => [...prev, data]);
      }
    });
    source.addEventListener("detection-ready", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      if (data.filename === event.source_filename) {
        setScanning(false);
        setSmokeHits([]);
        fetchDetections(event.id).then(setDetections).catch(() => {});
      }
    });
    return () => source.close();
  }, [event.id, event.source_filename]);

  // Auto-start Level2 scan 3 seconds after modal opens — only if no Level2 detections exist
  useEffect(() => {
    if (loading) return; // wait until initial detections are loaded
    const hasLevel2 = detections.some(d => d.det_level >= 2);
    if (hasLevel2) return; // already scanned, skip
    const timer = setTimeout(() => {
      setScanning(true);
      setSmokeHits([]);
      detectNow(event.source_filename);
    }, 3000);
    return () => clearTimeout(timer);
  }, [event.source_filename, loading, detections.length]);

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (editing) return;
      if (e.key === "Escape") {
        if (zoomedDetId !== null) {
          resetZoom();
          setPinnedDetId(null);
          setHoveredDetId(null);
        } else if (viewMode === "panel") {
          setViewMode("comic");
          setPinnedDetId(null);
        } else {
          onClose();
        }
        e.preventDefault();
      } else if (viewMode === "panel") {
        if (e.key === "ArrowLeft" && activePanel > 0) {
          scrollToPanel(activePanel - 1);
          e.preventDefault();
        } else if (e.key === "ArrowRight" && activePanel < 3) {
          scrollToPanel(activePanel + 1);
          e.preventDefault();
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [viewMode, activePanel, editing]);

  // Scroll observer for carousel — update activePanel
  useEffect(() => {
    const el = carouselRef.current;
    if (!el || viewMode !== "panel") return;
    let scrollTimer: ReturnType<typeof setTimeout>;
    function onScroll() {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (!el) return;
        const idx = Math.round(el.scrollLeft / el.clientWidth);
        if (idx >= 0 && idx <= 3) {
          setActivePanel(idx);
          history.replaceState(null, "", `/app/photo/${event.id}/panel/${idx}${location.search}`);
        }
      }, 50);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewMode]);

  // Draw panel crops when entering panel view (image already preloaded)
  useEffect(() => {
    if (viewMode !== "panel" || !comicImage) return;
    for (let i = 0; i < 4; i++) {
      const canvas = canvasRefs.current[i];
      if (!canvas) continue;
      const p = PANELS[i];
      canvas.width = p.w;
      canvas.height = p.h;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(comicImage, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
    }
  }, [viewMode, comicImage]);

  const scrollToPanel = useCallback((idx: number) => {
    resetZoom();
    setActivePanel(idx);
    history.replaceState(null, "", `/app/photo/${event.id}/panel/${idx}${location.search}`);
    const el = carouselRef.current;
    if (el) el.scrollTo({ left: idx * el.clientWidth, behavior: "smooth" });
  }, [event.id]);

  function showPanel(idx: number) {
    setViewMode("panel");
    setActivePanel(idx);
    setPinnedDetId(null);
    // Scroll after next render
    requestAnimationFrame(() => {
      const el = carouselRef.current;
      if (el) el.scrollTo({ left: idx * el.clientWidth, behavior: "auto" });
    });
  }

  function showComic() {
    resetZoom();
    setViewMode("comic");
    setPinnedDetId(null);
  }

  function handleDetClick(det: Detection) {
    const panel = panelOf(det);
    if (panel < 0) return;
    if (viewMode === "comic") {
      showPanel(panel);
      // Zoom after panel view renders
      requestAnimationFrame(() => {
        requestAnimationFrame(() => zoomToBbox(det.id, panel));
      });
    } else if (panel !== activePanel) {
      resetZoom();
      scrollToPanel(panel);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => zoomToBbox(det.id, panel));
      });
    } else {
      zoomToBbox(det.id, panel);
    }
  }

  function handleDetectionOverride(detId: number, newPetId: string) {
    updateDetectionOverride(detId, newPetId).then(() => {
      setDetections((prev) =>
        prev.map((d) => (d.id === detId ? { ...d, pet_id_override: newPetId } : d))
      );
      setEditingId(null);
    });
  }

  async function handleSave() {
    const patch: Record<string, unknown> = {};
    if (petId !== event.pet_id && petId) patch.pet_id = petId;
    if (behavior !== event.behavior && behavior) patch.behavior = behavior;
    const newIsValid = status === "valid" ? true : status === "invalid" ? false : null;
    const oldIsValid = event.status === "valid" ? true : event.status === "invalid" ? false : null;
    if (newIsValid !== oldIsValid && newIsValid !== null) patch.is_valid = newIsValid;
    if (Object.keys(patch).length > 0) {
      await updatePhotoFields(event.source_filename, patch);
      onUpdated?.({ pet_id: petId, behavior, status });
    }
    setEditing(false);
  }

  function handleCancel() {
    setPetId(event.pet_id);
    setStatus(event.status);
    setBehavior(event.behavior);
    setEditing(false);
  }

  // --- Zoom-to-bbox & drag-to-pan ---

  const RUBBER_MAX = 40;

  function clampTranslate(tx: number, ty: number, zoom: number, viewW: number, viewH: number, contentW: number, contentH: number) {
    return {
      tx: Math.max(viewW - contentW * zoom, Math.min(0, tx)),
      ty: Math.max(viewH - contentH * zoom, Math.min(0, ty)),
    };
  }

  function rubberBand(offset: number, limit: number): number {
    if (offset > 0) {
      return limit > 0 ? 0 : RUBBER_MAX * (1 - Math.exp(-offset / (RUBBER_MAX * 3)));
    }
    if (offset < limit) {
      const over = limit - offset;
      return limit - RUBBER_MAX * (1 - Math.exp(-over / (RUBBER_MAX * 3)));
    }
    return offset;
  }

  function applyZoom(wrapper: HTMLElement, tx: number, ty: number, zoom: number, animated: boolean) {
    wrapper.style.transition = animated ? "transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)" : "none";
    wrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
  }

  function zoomToBbox(detId: number, panelIdx: number) {
    const wrapper = wrapperRefs.current[panelIdx];
    const canvas = canvasRefs.current[panelIdx];
    if (!wrapper || !canvas || !canvas.width) return;
    const slide = wrapper.parentElement;
    if (!slide) return;

    if (zoomedDetId === detId) {
      // Un-zoom
      setZoomedDetId(null);
      zoomRef.current = { tx: 0, ty: 0, zoom: 1, panelIdx: -1, viewW: 0, viewH: 0, contentW: 0, contentH: 0 };
      applyZoom(wrapper, 0, 0, 1, true);
      wrapper.addEventListener("transitionend", () => { wrapper.style.transform = ""; }, { once: true });
      setPinnedDetId(null);
      setHoveredDetId(null);
      return;
    }

    const det = detections.find(d => d.id === detId);
    if (!det) return;
    const p = PANELS[panelIdx];
    const localX = det.bbox_x - p.x;
    const localY = det.bbox_y - p.y;

    // Canvas display size for coordinate transform
    const canvasW = canvas.clientWidth;
    const canvasH = canvas.clientHeight;
    const scaleX = canvasW / canvas.width;
    const scaleY = canvasH / canvas.height;

    const bboxCx = (localX + det.bbox_w / 2) * scaleX;
    const bboxCy = (localY + det.bbox_h / 2) * scaleY;
    const bboxDW = det.bbox_w * scaleX;
    const bboxDH = det.bbox_h * scaleY;

    // Viewport = slide, Content = canvas display size
    const viewW = slide.clientWidth;
    const viewH = slide.clientHeight;
    const contentW = canvasW;
    const contentH = canvasH;

    const zoomW = viewW * 0.5 / bboxDW;
    const zoomH = viewH * 0.5 / bboxDH;
    const zoom = Math.min(3.5, Math.max(1.8, Math.min(zoomW, zoomH)));

    let tx = viewW / 2 - bboxCx * zoom;
    let ty = viewH / 2 - bboxCy * zoom;
    const clamped = clampTranslate(tx, ty, zoom, viewW, viewH, contentW, contentH);
    tx = clamped.tx;
    ty = clamped.ty;

    setZoomedDetId(detId);
    setPinnedDetId(detId);
    zoomRef.current = { tx, ty, zoom, panelIdx, viewW, viewH, contentW, contentH };
    applyZoom(wrapper, tx, ty, zoom, true);
  }

  function resetZoom() {
    if (zoomedDetId === null) return;
    const wrapper = wrapperRefs.current[zoomRef.current.panelIdx];
    if (wrapper) {
      wrapper.style.transition = "";
      wrapper.style.transform = "";
    }
    setZoomedDetId(null);
    zoomRef.current = { tx: 0, ty: 0, zoom: 1, panelIdx: -1, viewW: 0, viewH: 0, contentW: 0, contentH: 0 };
  }

  // Drag-to-pan event handlers
  useEffect(() => {
    if (viewMode !== "panel") return;
    const el = carouselRef.current;
    if (!el) return;

    function onDragStart(x: number, y: number): boolean {
      if (zoomedDetId === null) return false;
      const wrapper = wrapperRefs.current[zoomRef.current.panelIdx];
      if (!wrapper) return false;
      dragRef.current = { startX: x, startY: y, startTx: zoomRef.current.tx, startTy: zoomRef.current.ty, wrapper };
      wrapper.style.transition = "none";
      return true;
    }

    function onDragMove(x: number, y: number) {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = x - drag.startX;
      const dy = y - drag.startY;
      const rawTx = drag.startTx + dx;
      const rawTy = drag.startTy + dy;
      const { zoom, viewW, viewH, contentW, contentH } = zoomRef.current;
      const minTx = viewW - contentW * zoom;
      const minTy = viewH - contentH * zoom;
      const tx = rubberBand(rawTx, minTx);
      const ty = rubberBand(rawTy, minTy);
      zoomRef.current.tx = rawTx;
      drag.wrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    }

    function onDragEnd() {
      const drag = dragRef.current;
      if (!drag) return;
      const { zoom, viewW, viewH, contentW, contentH } = zoomRef.current;
      const clamped = clampTranslate(zoomRef.current.tx, zoomRef.current.ty, zoom, viewW, viewH, contentW, contentH);
      zoomRef.current.tx = clamped.tx;
      zoomRef.current.ty = clamped.ty;
      applyZoom(drag.wrapper, clamped.tx, clamped.ty, zoom, true);
      dragRef.current = null;
    }

    function handleMouseDown(e: MouseEvent) {
      if (onDragStart(e.clientX, e.clientY)) e.preventDefault();
    }
    function handleMouseMove(e: MouseEvent) {
      if (dragRef.current) { e.preventDefault(); onDragMove(e.clientX, e.clientY); }
    }
    function handleMouseUp() { onDragEnd(); }

    function handleTouchStart(e: TouchEvent) {
      if (zoomedDetId !== null && e.touches.length === 1) {
        onDragStart(e.touches[0].clientX, e.touches[0].clientY);
      }
    }
    function handleTouchMove(e: TouchEvent) {
      if (dragRef.current) {
        e.preventDefault();
        onDragMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    }
    function handleTouchEnd() { onDragEnd(); }

    el.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd);
    el.addEventListener("touchcancel", handleTouchEnd);

    return () => {
      el.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [viewMode, zoomedDetId, detections]);

  // --- Bbox positioning ---

  function glassBboxStyle(det: Detection): Record<string, string> {
    const w = det.bbox_w * scale;
    const h = det.bbox_h * scale;
    return {
      left: `${offsetX + det.bbox_x * scale}px`,
      top: `${offsetY + det.bbox_y * scale}px`,
      width: `${w}px`,
      height: `${h}px`,
    };
  }

  function panelBboxStyle(det: Detection, panelIdx: number, canvas: HTMLCanvasElement | null): Record<string, string> | null {
    if (!canvas || !canvas.width) return null;
    const p = PANELS[panelIdx];
    const localX = det.bbox_x - p.x;
    const localY = det.bbox_y - p.y;
    const displayW = canvas.clientWidth;
    const displayH = canvas.clientHeight;
    const scaleX = displayW / canvas.width;
    const scaleY = displayH / canvas.height;
    return {
      left: `${localX * scaleX}px`,
      top: `${localY * scaleY}px`,
      width: `${det.bbox_w * scaleX}px`,
      height: `${det.bbox_h * scaleY}px`,
    };
  }

  // --- Detection list for current view ---
  const visibleDets = viewMode === "comic"
    ? detections
    : detsForPanel(detections, activePanel);

  const [copied, setCopied] = useState(false);
  function handleShare() {
    navigator.clipboard.writeText(location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const dlHref = viewMode === "panel"
    ? `${photoUrl(event.source_filename)}/panel/${activePanel}`
    : photoUrl(event.source_filename);
  const dlFilename = viewMode === "panel"
    ? event.source_filename.replace(".jpg", `_p${activePanel}.jpg`)
    : event.source_filename;

  return (
    <div class="detail-backdrop" onClick={onClose}>
      {/* SVG turbulence filter for smoke effect */}
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter id="smoke-turbulence">
          <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="3" seed="1">
            <animate attributeName="baseFrequency" values="0.015;0.025;0.015" dur="4s" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" scale="12" />
        </filter>
      </svg>
      <div class="detail-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" class="detail-close" onClick={onClose}>✕</button>

        {/* Breadcrumb */}
        {viewMode === "panel" && (
          <div class="carousel-breadcrumb">
            <button type="button" class="crumb" onClick={showComic}>Comic</button>
            <span class="crumb-sep">/</span>
            <span class="crumb current">Panel {activePanel}</span>
            <a class="pill dl" href={dlHref} download={dlFilename}>JPEG P{activePanel}</a>
            <button type="button" class="pill dl" onClick={handleShare}>{copied ? "Copied!" : "Share"}</button>
          </div>
        )}

        {/* Comic View — always mounted to preserve containerRef / scale */}
        <div class="detail-image-container" ref={containerRef} style={{ display: viewMode === "comic" ? "" : "none" }}>
            <img
              src={photoUrl(event.source_filename)}
              alt={event.summary ?? event.source_filename}
              class="detail-image"
            />
            {/* Glass bbox overlays */}
            {!scanning && detections.length > 0 && (
              <div
                class={`glass-overlay ${peekMode ? "peek" : ""}`}
                onMouseEnter={() => setPeekMode(true)}
                onMouseLeave={() => { setPeekMode(false); setHoveredDetId(null); }}
              >
                {detections.map((det) => (
                  <div
                    key={det.id}
                    class={`glass-bbox ${activeDetId === det.id ? "highlighted" : ""} ${peekMode && activeDetId !== det.id ? "dimmed" : ""}`}
                    style={glassBboxStyle(det)}
                    data-det-id={det.id}
                  >
                    <span
                      class="glass-shine"
                      ref={(el) => {
                        if (!el) return;
                        const w = det.bbox_w * scale;
                        const h = det.bbox_h * scale;
                        (el.style as any).offsetPath = `path("M 0,0 L ${w},0 L ${w},${h} L 0,${h} Z")`;
                      }}
                    />
                    <span
                      class="glass-shine glass-shine-b"
                      ref={(el) => {
                        if (!el) return;
                        const w = det.bbox_w * scale;
                        const h = det.bbox_h * scale;
                        (el.style as any).offsetPath = `path("M 0,0 L ${w},0 L ${w},${h} L 0,${h} Z")`;
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
            {/* Progressive scan: smoke */}
            {scanning && (
              <div class="glass-overlay scan-active">
                {smokeHits.map((hit, i) => (
                  <div
                    key={i}
                    class="smoke-detection"
                    style={{
                      left: `${offsetX + (hit.bbox_x + hit.bbox_w / 2) * scale}px`,
                      top: `${offsetY + (hit.bbox_y + hit.bbox_h / 2) * scale}px`,
                      width: `${Math.max(hit.bbox_w, hit.bbox_h) * scale * 1.2}px`,
                      height: `${Math.max(hit.bbox_w, hit.bbox_h) * scale * 1.2}px`,
                      animationDelay: `0s, ${(i * 0.4) % 2}s`,
                    }}
                  />
                ))}
              </div>
            )}
            {/* Clickable panel regions */}
            {!scanning && (
              <div class="comic-panel-regions" style={{
                left: `${offsetX}px`,
                top: `${offsetY}px`,
                width: `${COMIC_W * scale}px`,
                height: `${COMIC_H * scale}px`,
              }}>
                {[0, 1, 2, 3].map(i => (
                  <button
                    key={i}
                    type="button"
                    class="comic-panel-region"
                    onClick={() => showPanel(i)}
                    aria-label={`View panel ${i}`}
                  />
                ))}
              </div>
            )}
          </div>

        {/* Panel Carousel View */}
        {viewMode === "panel" && (
          <div class="carousel-wrapper">
            <div class="panel-carousel" ref={carouselRef}>
              {[0, 1, 2, 3].map(i => (
                <div key={i} class="panel-slide" data-panel={i}>
                  <div
                    class="zoom-wrapper"
                    ref={(el) => { wrapperRefs.current[i] = el; }}
                  >
                    <canvas
                      ref={(el) => { canvasRefs.current[i] = el; }}
                      style={{ width: "100%", height: "auto" }}
                    />
                    {/* Interactive bbox overlay */}
                    {detections.length > 0 && (
                      <div class="bbox-overlay">
                        {detsForPanel(detections, i).map(det => {
                          const style = panelBboxStyle(det, i, canvasRefs.current[i]);
                          if (!style) return null;
                          const isZoomTarget = zoomedDetId === det.id;
                          const tier = classTier(det);
                          return (
                            <div
                              key={det.id}
                              class={`bbox tier-${tier} ${activeDetId === det.id ? "highlighted" : ""} ${isZoomTarget ? "zoom-target" : ""} ${activeDetId !== null && activeDetId !== det.id ? "dimmed" : ""}`}
                              style={style}
                              data-det-id={det.id}
                              onMouseEnter={() => setHoveredDetId(det.id)}
                              onMouseLeave={() => setHoveredDetId(null)}
                              onClick={(e) => { e.stopPropagation(); zoomToBbox(det.id, i); }}
                            >
                              <span
                                class="bbox-label"
                                style={{ background: bboxColor(det) }}
                              >
                                {det.pet_id_override ?? det.pet_class ?? det.yolo_class ?? "?"}
                              </span>
                              {tier === "low" && <span class="bbox-sparkle" />}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {/* Nav buttons */}
            {activePanel > 0 && (
              <button
                type="button"
                class="carousel-nav-btn prev"
                onClick={() => scrollToPanel(activePanel - 1)}
                aria-label="Previous panel"
              >&#8249;</button>
            )}
            {activePanel < 3 && (
              <button
                type="button"
                class="carousel-nav-btn next"
                onClick={() => scrollToPanel(activePanel + 1)}
                aria-label="Next panel"
              >&#8250;</button>
            )}
            {/* Dot indicators */}
            <div class="carousel-dots">
              {[0, 1, 2, 3].map(i => (
                <button
                  key={i}
                  type="button"
                  class={`panel-dot ${i === activePanel ? "active" : ""}`}
                  onClick={() => scrollToPanel(i)}
                  aria-label={`Panel ${i}`}
                />
              ))}
            </div>
          </div>
        )}

        <div class="detail-info">
          <div class="detail-caption-row">
            <p class="detail-caption">{event.summary ?? "No summary"}</p>
            {scanning && <span class="detect-now-status">Scanning...</span>}
            {viewMode === "comic" && (
              <>
                <a class="pill dl" href={photoUrl(event.source_filename)} download={event.source_filename}>JPEG</a>
                <button type="button" class="pill dl" onClick={handleShare}>{copied ? "Copied!" : "Share"}</button>
              </>
            )}
          </div>

          {editing ? (
            <div class="detail-edit-form">
              <div class="edit-row">
                <label>Pet</label>
                <span class="pet-select">
                  {PET_OPTIONS.map((opt) => (
                    <button
                      type="button"
                      class={`pet-opt ${petId === opt ? "selected" : ""}`}
                      onClick={() => setPetId(opt)}
                    >
                      {petDisplay(opt, petNames)}
                    </button>
                  ))}
                </span>
              </div>
              <div class="edit-row">
                <label>Status</label>
                <span class="pet-select">
                  {(["valid", "invalid"] as const).map((opt) => (
                    <button
                      type="button"
                      class={`pet-opt ${status === opt ? "selected" : ""}`}
                      onClick={() => setStatus(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </span>
              </div>
              <div class="edit-row">
                <label>Behavior</label>
                <span class="pet-select">
                  {BEHAVIOR_OPTIONS.map((opt) => (
                    <button
                      type="button"
                      class={`pet-opt ${behavior === opt ? "selected" : ""}`}
                      onClick={() => setBehavior(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </span>
              </div>
              <div class="edit-actions">
                <button type="button" class="edit-save" onClick={handleSave}>Save</button>
                <button type="button" class="edit-cancel" onClick={handleCancel}>Cancel</button>
              </div>
            </div>
          ) : (
            <div class="detail-meta">
              <span class="pet-pill">{petDisplay(petId, petNames)}</span>
              <span class={`status-pill ${status}`}>{status}</span>
              <span>{behavior ?? ""}</span>
              <span>{new Date(event.observed_at).toLocaleString()}</span>
              <button
                type="button"
                class="detail-edit-btn"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            </div>
          )}
        </div>

        {/* Detection list */}
        {!loading && visibleDets.length > 0 && (
          <div class="detail-detections">
            <strong>
              Detections ({visibleDets.length})
              {viewMode === "panel" && ` — Panel ${activePanel}`}
            </strong>
            <ul>
              {visibleDets.map((det) => (
                <li
                  key={det.id}
                  class={`det-item ${activeDetId === det.id ? "highlighted" : ""}`}
                  onMouseEnter={() => setHoveredDetId(det.id)}
                  onMouseLeave={() => setHoveredDetId(null)}
                  onClick={() => handleDetClick(det)}
                >
                  <span class="det-color" style={{ background: bboxColor(det) }} />
                  <span class="det-class">{det.yolo_class ?? "?"}</span>
                  {(det.pet_id_override ?? det.pet_class) && (
                    <span class="det-pet">{petDisplay(det.pet_id_override ?? det.pet_class, petNames)}</span>
                  )}
                  <span class="det-conf-wrap">
                    {det.confidence != null && (
                      <>
                        <span class="det-conf-bar">
                          <span
                            class="det-conf-fill"
                            style={{
                              width: `${det.confidence * 100}%`,
                              background: bboxColor(det),
                            }}
                          />
                        </span>
                        <span class="det-conf">{(det.confidence * 100).toFixed(0)}%</span>
                      </>
                    )}
                  </span>
                  {det.yolo_class === "cat" && (
                    editingId === det.id ? (
                      <span class="pet-select">
                        {PET_OPTIONS.map((opt) => (
                          <button
                            type="button"
                            class={`pet-opt ${(det.pet_id_override ?? det.pet_class) === opt ? "selected" : ""}`}
                            onClick={(e) => { e.stopPropagation(); handleDetectionOverride(det.id, opt); }}
                          >
                            {petDisplay(opt, petNames)}
                          </button>
                        ))}
                        <button
                          type="button"
                          class="pet-opt cancel"
                          onClick={(e) => { e.stopPropagation(); setEditingId(null); }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        class="detection-edit"
                        onClick={(e) => { e.stopPropagation(); setEditingId(det.id); }}
                      >
                        edit
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
