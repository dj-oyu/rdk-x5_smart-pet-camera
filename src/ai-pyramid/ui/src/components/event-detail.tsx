import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "preact/hooks";
import {
  updateDetectionOverride,
  updatePhotoFields,
  photoUrl,
  type Detection,
  type EventSummary,
  type PetNames,
} from "../lib/api";
import {
  createDetailStore,
  PANELS, PW,
  bboxColor, classTier, panelOf,
  type DetailStore,
} from "../lib/detail-store";

const COMIC_W = 848;
const COMIC_H = 496;

const PET_OPTIONS = ["mike", "chatora", "other"];
const BEHAVIOR_OPTIONS = [
  "eating", "drinking", "sleeping", "playing", "resting", "moving", "grooming", "other",
];

function petDisplay(id: string | null, petNames: PetNames): string {
  if (!id) return "unknown";
  return petNames[id] ?? id;
}

function useContainerScale(ref: preact.RefObject<HTMLDivElement | null>) {
  const [layout, setLayout] = useState({ scale: 1, offsetX: 0, offsetY: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const scale = Math.min(w / COMIC_W, h / COMIC_H);
      setLayout({ scale, offsetX: (w - COMIC_W * scale) / 2, offsetY: (h - COMIC_H * scale) / 2 });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return layout;
}

type Props = {
  event: EventSummary;
  petNames: PetNames;
  onClose: () => void;
  onUpdated?: () => void;
  initialPanel?: number | null;
};

export function EventDetail({ event, petNames, onClose, onUpdated, initialPanel }: Props) {
  const store = useMemo(() => createDetailStore(event, initialPanel ?? null), [event.id]);
  useEffect(() => () => store.dispose(), [store]);

  const s = store; // short alias

  // DOM refs
  const containerRef = useRef<HTMLDivElement | null>(null);
  const carouselRef = useRef<HTMLDivElement | null>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([null, null, null, null]);
  const wrapperRefs = useRef<(HTMLDivElement | null)[]>([null, null, null, null]);
  const hdProgressRef = useRef<HTMLDivElement | null>(null);
  const { scale, offsetX, offsetY } = useContainerScale(containerRef);

  // Zoom state (imperative, not reactive)
  const zoomRef = useRef({ tx: 0, ty: 0, zoom: 1, panelIdx: -1, viewW: 0, viewH: 0, contentW: 0, contentH: 0 });
  const dragRef = useRef<{ startX: number; startY: number; startTx: number; startTy: number; wrapper: HTMLElement } | null>(null);

  // --- Draw panel crops when viewMode=panel and image ready ---
  useEffect(() => {
    if (s.viewMode.value !== "panel" || !s.comicImage.value) return;
    const img = s.comicImage.value;
    for (let i = 0; i < 4; i++) {
      const canvas = canvasRefs.current[i];
      if (!canvas) continue;
      const p = PANELS[i];
      canvas.width = p.w;
      canvas.height = p.h;
      canvas.getContext("2d")?.drawImage(img, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
    }
  }, [s.viewMode.value, s.comicImage.value]);

  // --- Auto upscale ---
  useEffect(() => {
    if (s.viewMode.value !== "panel" || !s.comicImage.value) return;
    if (!s.upscaleState.peek()[s.activePanel.value]) {
      s.upscalePanel(s.activePanel.value, "general_fast", canvasRefs.current, hdProgressRef.current);
    }
  }, [s.viewMode.value, s.activePanel.value, s.comicImage.value]);

  // --- Keyboard navigation ---
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (s.editing.value) return;
      if (e.key === "Escape") {
        if (s.zoomedDetId.value !== null) {
          resetZoom();
          s.pinnedDetId.value = null;
          s.hoveredDetId.value = null;
        } else if (s.viewMode.value === "panel") {
          showComic();
        } else {
          onClose();
        }
        e.preventDefault();
      } else if (s.viewMode.value === "panel") {
        if (e.key === "ArrowLeft" && s.activePanel.value > 0) {
          scrollToPanel(s.activePanel.value - 1);
          e.preventDefault();
        } else if (e.key === "ArrowRight" && s.activePanel.value < 3) {
          scrollToPanel(s.activePanel.value + 1);
          e.preventDefault();
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // --- Scroll observer ---
  useEffect(() => {
    const el = carouselRef.current;
    if (!el || s.viewMode.value !== "panel") return;
    let timer: ReturnType<typeof setTimeout>;
    function onScroll() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!el) return;
        const idx = Math.round(el.scrollLeft / el.clientWidth);
        if (idx >= 0 && idx <= 3) {
          s.activePanel.value = idx;
          history.replaceState(null, "", `/app/photo/${event.id}/panel/${idx}${location.search}`);
        }
      }, 50);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [s.viewMode.value]);

  // --- Drag-to-pan ---
  useEffect(() => {
    if (s.viewMode.value !== "panel") return;
    const el = carouselRef.current;
    if (!el) return;
    const RUBBER_MAX = 40;

    function rubberBand(offset: number, limit: number): number {
      if (offset > 0) return limit > 0 ? 0 : RUBBER_MAX * (1 - Math.exp(-offset / (RUBBER_MAX * 3)));
      if (offset < limit) { const over = limit - offset; return limit - RUBBER_MAX * (1 - Math.exp(-over / (RUBBER_MAX * 3))); }
      return offset;
    }

    function onDragStart(x: number, y: number): boolean {
      if (s.zoomedDetId.value === null) return false;
      const wrapper = wrapperRefs.current[zoomRef.current.panelIdx];
      if (!wrapper) return false;
      dragRef.current = { startX: x, startY: y, startTx: zoomRef.current.tx, startTy: zoomRef.current.ty, wrapper };
      wrapper.style.transition = "none";
      return true;
    }
    function onDragMove(x: number, y: number) {
      const drag = dragRef.current;
      if (!drag) return;
      const { zoom, viewW, viewH, contentW, contentH } = zoomRef.current;
      const rawTx = drag.startTx + (x - drag.startX);
      const rawTy = drag.startTy + (y - drag.startY);
      const tx = rubberBand(rawTx, viewW - contentW * zoom);
      const ty = rubberBand(rawTy, viewH - contentH * zoom);
      zoomRef.current.tx = rawTx;
      drag.wrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    }
    function onDragEnd() {
      const drag = dragRef.current;
      if (!drag) return;
      const { zoom, viewW, viewH, contentW, contentH } = zoomRef.current;
      const tx = Math.max(viewW - contentW * zoom, Math.min(0, zoomRef.current.tx));
      const ty = Math.max(viewH - contentH * zoom, Math.min(0, zoomRef.current.ty));
      zoomRef.current.tx = tx;
      zoomRef.current.ty = ty;
      drag.wrapper.style.transition = "transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)";
      drag.wrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
      dragRef.current = null;
    }
    function onMD(e: MouseEvent) { if (onDragStart(e.clientX, e.clientY)) e.preventDefault(); }
    function onMM(e: MouseEvent) { if (dragRef.current) { e.preventDefault(); onDragMove(e.clientX, e.clientY); } }
    function onMU() { onDragEnd(); }
    function onTS(e: TouchEvent) { if (s.zoomedDetId.value !== null && e.touches.length === 1) onDragStart(e.touches[0].clientX, e.touches[0].clientY); }
    function onTM(e: TouchEvent) { if (dragRef.current) { e.preventDefault(); onDragMove(e.touches[0].clientX, e.touches[0].clientY); } }
    function onTE() { onDragEnd(); }
    el.addEventListener("mousedown", onMD);
    window.addEventListener("mousemove", onMM);
    window.addEventListener("mouseup", onMU);
    el.addEventListener("touchstart", onTS, { passive: true });
    el.addEventListener("touchmove", onTM, { passive: false });
    el.addEventListener("touchend", onTE);
    el.addEventListener("touchcancel", onTE);
    return () => {
      el.removeEventListener("mousedown", onMD);
      window.removeEventListener("mousemove", onMM);
      window.removeEventListener("mouseup", onMU);
      el.removeEventListener("touchstart", onTS);
      el.removeEventListener("touchmove", onTM);
      el.removeEventListener("touchend", onTE);
      el.removeEventListener("touchcancel", onTE);
    };
  }, [s.viewMode.value]);

  // --- Navigation helpers ---
  function scrollToPanel(idx: number) {
    resetZoom();
    s.activePanel.value = idx;
    history.replaceState(null, "", `/app/photo/${event.id}/panel/${idx}${location.search}`);
    carouselRef.current?.scrollTo({ left: idx * (carouselRef.current?.clientWidth ?? 0), behavior: "smooth" });
  }

  function showPanel(idx: number) {
    s.viewMode.value = "panel";
    s.activePanel.value = idx;
    s.pinnedDetId.value = null;
    requestAnimationFrame(() => {
      carouselRef.current?.scrollTo({ left: idx * (carouselRef.current?.clientWidth ?? 0), behavior: "auto" });
    });
  }

  function showComic() {
    resetZoom();
    s.viewMode.value = "comic";
    s.pinnedDetId.value = null;
  }

  // --- Zoom ---
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

    if (s.zoomedDetId.value === detId) {
      s.zoomedDetId.value = null;
      zoomRef.current = { tx: 0, ty: 0, zoom: 1, panelIdx: -1, viewW: 0, viewH: 0, contentW: 0, contentH: 0 };
      applyZoom(wrapper, 0, 0, 1, true);
      wrapper.addEventListener("transitionend", () => { wrapper.style.transform = ""; }, { once: true });
      s.pinnedDetId.value = null;
      s.hoveredDetId.value = null;
      return;
    }

    const det = s.detections.value.find(d => d.id === detId);
    if (!det) return;
    const p = PANELS[panelIdx];
    const localX = det.bbox_x - p.x;
    const localY = det.bbox_y - p.y;
    const mult = canvas.width > PW ? canvas.width / PW : 1;
    const scaleX = canvas.clientWidth / canvas.width;
    const scaleY = canvas.clientHeight / canvas.height;
    const bboxCx = (localX + det.bbox_w / 2) * mult * scaleX;
    const bboxCy = (localY + det.bbox_h / 2) * mult * scaleY;
    const bboxDW = det.bbox_w * mult * scaleX;
    const bboxDH = det.bbox_h * mult * scaleY;
    const viewW = slide.clientWidth;
    const viewH = slide.clientHeight;
    const zoom = Math.min(3.5, Math.max(1.8, Math.min(viewW * 0.5 / bboxDW, viewH * 0.5 / bboxDH)));
    let tx = viewW / 2 - bboxCx * zoom;
    let ty = viewH / 2 - bboxCy * zoom;
    tx = Math.max(viewW - canvas.clientWidth * zoom, Math.min(0, tx));
    ty = Math.max(viewH - canvas.clientHeight * zoom, Math.min(0, ty));
    s.zoomedDetId.value = detId;
    s.pinnedDetId.value = detId;
    zoomRef.current = { tx, ty, zoom, panelIdx, viewW, viewH, contentW: canvas.clientWidth, contentH: canvas.clientHeight };
    applyZoom(wrapper, tx, ty, zoom, true);
  }

  function resetZoom() {
    if (s.zoomedDetId.value === null) return;
    const wrapper = wrapperRefs.current[zoomRef.current.panelIdx];
    if (wrapper) { wrapper.style.transition = ""; wrapper.style.transform = ""; }
    s.zoomedDetId.value = null;
    zoomRef.current = { tx: 0, ty: 0, zoom: 1, panelIdx: -1, viewW: 0, viewH: 0, contentW: 0, contentH: 0 };
  }

  // --- Detection interaction ---
  function handleDetClick(det: Detection) {
    const panel = panelOf(det);
    if (panel < 0) return;
    if (s.viewMode.value === "comic") {
      showPanel(panel);
      requestAnimationFrame(() => requestAnimationFrame(() => zoomToBbox(det.id, panel)));
    } else if (panel !== s.activePanel.value) {
      resetZoom();
      scrollToPanel(panel);
      requestAnimationFrame(() => requestAnimationFrame(() => zoomToBbox(det.id, panel)));
    } else {
      zoomToBbox(det.id, panel);
    }
  }

  function handleDetectionOverride(detId: number, newPetId: string) {
    updateDetectionOverride(detId, newPetId).then(() => {
      s.detections.value = s.detections.value.map(d => d.id === detId ? { ...d, pet_id_override: newPetId } : d);
      s.editingId.value = null;
    });
  }

  async function handleSave() {
    const patch: Record<string, unknown> = {};
    if (s.formPetId.value !== event.pet_id && s.formPetId.value) patch.pet_id = s.formPetId.value;
    if (s.formBehavior.value !== event.behavior && s.formBehavior.value) patch.behavior = s.formBehavior.value;
    const newIsValid = s.formStatus.value === "valid" ? true : s.formStatus.value === "invalid" ? false : null;
    const oldIsValid = event.status === "valid" ? true : event.status === "invalid" ? false : null;
    if (newIsValid !== oldIsValid && newIsValid !== null) patch.is_valid = newIsValid;
    if (Object.keys(patch).length > 0) {
      await updatePhotoFields(event.source_filename, patch);
      onUpdated?.();
    }
    s.editing.value = false;
  }

  function handleCancel() {
    s.formPetId.value = event.pet_id;
    s.formStatus.value = event.status;
    s.formBehavior.value = event.behavior;
    s.editing.value = false;
  }

  function handleShare() {
    navigator.clipboard.writeText(location.href).then(() => {
      s.copied.value = true;
      setTimeout(() => { s.copied.value = false; }, 2000);
    });
  }

  // --- Bbox positioning ---
  function glassBboxStyle(det: Detection): Record<string, string> {
    return {
      left: `${offsetX + det.bbox_x * scale}px`,
      top: `${offsetY + det.bbox_y * scale}px`,
      width: `${det.bbox_w * scale}px`,
      height: `${det.bbox_h * scale}px`,
    };
  }

  function panelBboxStyle(det: Detection, panelIdx: number, canvas: HTMLCanvasElement | null): Record<string, string> | null {
    if (!canvas || !canvas.width) return null;
    const p = PANELS[panelIdx];
    const mult = canvas.width > PW ? canvas.width / PW : 1;
    const scaleX = canvas.clientWidth / canvas.width;
    const scaleY = canvas.clientHeight / canvas.height;
    return {
      left: `${(det.bbox_x - p.x) * mult * scaleX}px`,
      top: `${(det.bbox_y - p.y) * mult * scaleY}px`,
      width: `${det.bbox_w * mult * scaleX}px`,
      height: `${det.bbox_h * mult * scaleY}px`,
    };
  }

  // --- Computed values ---
  const dlHref = s.viewMode.value === "panel"
    ? `${photoUrl(event.source_filename)}/panel/${s.activePanel.value}`
    : photoUrl(event.source_filename);
  const dlFilename = s.viewMode.value === "panel"
    ? event.source_filename.replace(".jpg", `_p${s.activePanel.value}.jpg`)
    : event.source_filename;

  return (
    <div class="detail-backdrop" onClick={onClose}>
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
        {s.viewMode.value === "panel" && (
          <div class="carousel-breadcrumb">
            <button type="button" class="crumb" onClick={showComic}>Comic</button>
            <span class="crumb-sep">/</span>
            <span class="crumb current">Panel {s.activePanel.value}</span>
            <a class="pill dl" href={dlHref} download={dlFilename}>JPEG P{s.activePanel.value}</a>
            <button type="button" class="pill dl" onClick={handleShare}>{s.copied.value ? "Copied!" : "Share"}</button>
          </div>
        )}

        {/* Comic View — always mounted */}
        <div class="detail-image-container" ref={containerRef} style={{ display: s.viewMode.value === "comic" ? "" : "none" }}>
          <img src={photoUrl(event.source_filename)} alt={event.summary ?? event.source_filename} class="detail-image" />
          {!s.scanning.value && s.detections.value.length > 0 && (
            <div
              class={`glass-overlay ${s.peekMode.value ? "peek" : ""}`}
              onMouseEnter={() => { s.peekMode.value = true; }}
              onMouseLeave={() => { s.peekMode.value = false; s.hoveredDetId.value = null; }}
            >
              {s.detections.value.map(det => (
                <div
                  key={det.id}
                  class={`glass-bbox ${s.activeDetId.value === det.id ? "highlighted" : ""} ${s.peekMode.value && s.activeDetId.value !== det.id ? "dimmed" : ""}`}
                  style={glassBboxStyle(det)}
                >
                  <span class="glass-shine" ref={el => {
                    if (!el) return;
                    const w = det.bbox_w * scale, h = det.bbox_h * scale;
                    (el.style as any).offsetPath = `path("M 0,0 L ${w},0 L ${w},${h} L 0,${h} Z")`;
                  }} />
                  <span class="glass-shine glass-shine-b" ref={el => {
                    if (!el) return;
                    const w = det.bbox_w * scale, h = det.bbox_h * scale;
                    (el.style as any).offsetPath = `path("M 0,0 L ${w},0 L ${w},${h} L 0,${h} Z")`;
                  }} />
                </div>
              ))}
            </div>
          )}
          {s.scanning.value && (
            <div class="glass-overlay scan-active">
              {s.smokeHits.value.map((hit, i) => (
                <div key={i} class="smoke-detection" style={{
                  left: `${offsetX + (hit.bbox_x + hit.bbox_w / 2) * scale}px`,
                  top: `${offsetY + (hit.bbox_y + hit.bbox_h / 2) * scale}px`,
                  width: `${Math.max(hit.bbox_w, hit.bbox_h) * scale * 1.2}px`,
                  height: `${Math.max(hit.bbox_w, hit.bbox_h) * scale * 1.2}px`,
                  animationDelay: `0s, ${(i * 0.4) % 2}s`,
                }} />
              ))}
            </div>
          )}
          {!s.scanning.value && (
            <div class="comic-panel-regions" style={{
              left: `${offsetX}px`, top: `${offsetY}px`,
              width: `${COMIC_W * scale}px`, height: `${COMIC_H * scale}px`,
            }}>
              {[0,1,2,3].map(i => (
                <button key={i} type="button" class="comic-panel-region" onClick={() => showPanel(i)} aria-label={`View panel ${i}`} />
              ))}
            </div>
          )}
        </div>

        {/* Panel Carousel */}
        {s.viewMode.value === "panel" && (
          <div class="carousel-wrapper">
            <div class="panel-carousel" ref={carouselRef}>
              {[0,1,2,3].map(i => (
                <div key={i} class="panel-slide" data-panel={i}>
                  <div class="zoom-wrapper" ref={el => { wrapperRefs.current[i] = el; }}>
                    <canvas ref={el => { canvasRefs.current[i] = el; }} style={{ width: "100%", height: "auto" }} />
                    {s.detections.value.length > 0 && (
                      <div class="bbox-overlay">
                        {s.visibleDets.value.filter(d => panelOf(d) === i).map(det => {
                          const style = panelBboxStyle(det, i, canvasRefs.current[i]);
                          if (!style) return null;
                          const tier = classTier(det);
                          return (
                            <div
                              key={det.id}
                              class={`bbox tier-${tier} ${s.activeDetId.value === det.id ? "highlighted" : ""} ${s.zoomedDetId.value === det.id ? "zoom-target" : ""} ${s.activeDetId.value !== null && s.activeDetId.value !== det.id ? "dimmed" : ""}`}
                              style={style}
                              onMouseEnter={() => { s.hoveredDetId.value = det.id; }}
                              onMouseLeave={() => { s.hoveredDetId.value = null; }}
                              onClick={e => { e.stopPropagation(); zoomToBbox(det.id, i); }}
                            >
                              <span class="bbox-label" style={{ background: bboxColor(det) }}>
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
            {s.activePanel.value > 0 && (
              <button type="button" class="carousel-nav-btn prev" onClick={() => scrollToPanel(s.activePanel.value - 1)}>&#8249;</button>
            )}
            {s.activePanel.value < 3 && (
              <button type="button" class="carousel-nav-btn next" onClick={() => scrollToPanel(s.activePanel.value + 1)}>&#8250;</button>
            )}
            <div class="carousel-dots">
              {[0,1,2,3].map(i => (
                <button key={i} type="button" class={`panel-dot ${i === s.activePanel.value ? "active" : ""}`} onClick={() => scrollToPanel(i)} />
              ))}
            </div>
            <button
              type="button"
              class={`hd-btn ${s.hdLoading.value ? "loading" : ""} ${s.upscaleState.value[s.activePanel.value] === "hd" ? "done" : ""}`}
              onClick={() => {
                if (!s.hdLoading.value && s.upscaleState.value[s.activePanel.value] !== "hd") {
                  s.upscalePanel(s.activePanel.value, "general_plus", canvasRefs.current, hdProgressRef.current);
                }
              }}
            >HD</button>
            <div class="hd-progress" ref={hdProgressRef} style={{ width: 0 }} />
            {s.upscaleState.value[s.activePanel.value] && (
              <span class="upscale-badge">{s.upscaleState.value[s.activePanel.value] === "hd" ? "4× HD" : "4× fast"}</span>
            )}
          </div>
        )}

        <div class="detail-info">
          <div class="detail-caption-row">
            <p class="detail-caption">{event.summary ?? "No summary"}</p>
            {s.scanning.value && <span class="detect-now-status">Scanning...</span>}
            {s.viewMode.value === "comic" && (
              <>
                <a class="pill dl" href={photoUrl(event.source_filename)} download={event.source_filename}>JPEG</a>
                <button type="button" class="pill dl" onClick={handleShare}>{s.copied.value ? "Copied!" : "Share"}</button>
              </>
            )}
          </div>

          {s.editing.value ? (
            <div class="detail-edit-form">
              <div class="edit-row">
                <label>Pet</label>
                <span class="pet-select">
                  {PET_OPTIONS.map(opt => (
                    <button type="button" class={`pet-opt ${s.formPetId.value === opt ? "selected" : ""}`} onClick={() => { s.formPetId.value = opt; }}>
                      {petDisplay(opt, petNames)}
                    </button>
                  ))}
                </span>
              </div>
              <div class="edit-row">
                <label>Status</label>
                <span class="pet-select">
                  {(["valid", "invalid"] as const).map(opt => (
                    <button type="button" class={`pet-opt ${s.formStatus.value === opt ? "selected" : ""}`} onClick={() => { s.formStatus.value = opt; }}>
                      {opt}
                    </button>
                  ))}
                </span>
              </div>
              <div class="edit-row">
                <label>Behavior</label>
                <span class="pet-select">
                  {BEHAVIOR_OPTIONS.map(opt => (
                    <button type="button" class={`pet-opt ${s.formBehavior.value === opt ? "selected" : ""}`} onClick={() => { s.formBehavior.value = opt; }}>
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
              <span class="pet-pill">{petDisplay(s.formPetId.value, petNames)}</span>
              <span class={`status-pill ${s.formStatus.value}`}>{s.formStatus.value}</span>
              <span>{s.formBehavior.value ?? ""}</span>
              <span>{new Date(event.observed_at).toLocaleString()}</span>
              <button type="button" class="detail-edit-btn" onClick={() => { s.editing.value = true; }}>Edit</button>
            </div>
          )}
        </div>

        {/* Detection list */}
        {!s.detLoading.value && s.visibleDets.value.length > 0 && (
          <div class="detail-detections">
            <strong>
              Detections ({s.visibleDets.value.length})
              {s.viewMode.value === "panel" && ` — Panel ${s.activePanel.value}`}
            </strong>
            <ul>
              {s.visibleDets.value.map(det => (
                <li
                  key={det.id}
                  class={`det-item ${s.activeDetId.value === det.id ? "highlighted" : ""}`}
                  onMouseEnter={() => { s.hoveredDetId.value = det.id; }}
                  onMouseLeave={() => { s.hoveredDetId.value = null; }}
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
                          <span class="det-conf-fill" style={{ width: `${det.confidence * 100}%`, background: bboxColor(det) }} />
                        </span>
                        <span class="det-conf">{(det.confidence * 100).toFixed(0)}%</span>
                      </>
                    )}
                  </span>
                  {det.yolo_class === "cat" && (
                    s.editingId.value === det.id ? (
                      <span class="pet-select">
                        {PET_OPTIONS.map(opt => (
                          <button type="button" class={`pet-opt ${(det.pet_id_override ?? det.pet_class) === opt ? "selected" : ""}`}
                            onClick={e => { e.stopPropagation(); handleDetectionOverride(det.id, opt); }}>
                            {petDisplay(opt, petNames)}
                          </button>
                        ))}
                        <button type="button" class="pet-opt cancel" onClick={e => { e.stopPropagation(); s.editingId.value = null; }}>Cancel</button>
                      </span>
                    ) : (
                      <button type="button" class="detection-edit" onClick={e => { e.stopPropagation(); s.editingId.value = det.id; }}>edit</button>
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
