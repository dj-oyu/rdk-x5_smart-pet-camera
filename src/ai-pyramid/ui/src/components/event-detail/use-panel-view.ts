import { useEffect, useRef } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import type { Detection, EventSummary } from "../../lib/api";
import { PANELS, PW, panelOf, type DetailStore } from "../../lib/detail-store";

type ZoomState = {
  tx: number;
  ty: number;
  zoom: number;
  panelIdx: number;
  viewW: number;
  viewH: number;
  contentW: number;
  contentH: number;
};

const EMPTY_ZOOM: ZoomState = {
  tx: 0, ty: 0, zoom: 1, panelIdx: -1,
  viewW: 0, viewH: 0, contentW: 0, contentH: 0,
};

export function usePanelView(store: DetailStore, event: EventSummary, onClose: () => void) {
  const carouselRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([null, null, null, null]);
  const wrapperRefs = useRef<(HTMLDivElement | null)[]>([null, null, null, null]);
  const hdProgressRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomState>({ ...EMPTY_ZOOM });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
    wrapper: HTMLElement;
  } | null>(null);

  useSignalEffect(() => {
    if (store.viewMode.value !== "panel" || !store.comicImage.value) return;
    const img = store.comicImage.value;
    for (let i = 0; i < 4; i++) {
      const canvas = canvasRefs.current[i];
      if (!canvas) continue;
      const panel = PANELS[i];
      canvas.width = panel.w;
      canvas.height = panel.h;
      canvas.getContext("2d")?.drawImage(img, panel.x, panel.y, panel.w, panel.h, 0, 0, panel.w, panel.h);
    }
  });

  useEffect(() => {
    if (store.viewMode.value === "panel" && store.activePanel.value > 0) {
      requestAnimationFrame(() => {
        carouselRef.current?.scrollTo({
          left: store.activePanel.value * (carouselRef.current?.clientWidth ?? 0),
          behavior: "auto",
        });
      });
    }
  }, []);

  useSignalEffect(() => {
    if (store.viewMode.value !== "panel" || !store.comicImage.value) return;
    if (!store.upscaleState.peek()[store.activePanel.value]) {
      store.upscalePanel(store.activePanel.value, "general_fast", canvasRefs.current, hdProgressRef.current);
    }
  });

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (store.editing.value) return;
      if (e.key === "Escape") {
        if (store.zoomedDetId.value !== null) {
          resetZoom();
          store.pinnedDetId.value = null;
          store.hoveredDetId.value = null;
        } else if (store.viewMode.value === "panel") {
          showComic();
        } else {
          onClose();
        }
        e.preventDefault();
      } else if (store.viewMode.value === "panel") {
        if (e.key === "ArrowLeft" && store.activePanel.value > 0) {
          scrollToPanel(store.activePanel.value - 1);
          e.preventDefault();
        } else if (e.key === "ArrowRight" && store.activePanel.value < 3) {
          scrollToPanel(store.activePanel.value + 1);
          e.preventDefault();
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  useEffect(() => {
    const el = carouselRef.current;
    if (!el || store.viewMode.value !== "panel") return;
    const carousel = el;
    let timer: ReturnType<typeof setTimeout>;
    function onScroll() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
        if (idx >= 0 && idx <= 3) {
          store.activePanel.value = idx;
          history.replaceState(null, "", `/app/photo/${event.id}/panel/${idx}${location.search}`);
        }
      }, 50);
    }
    carousel.addEventListener("scroll", onScroll, { passive: true });
    return () => carousel.removeEventListener("scroll", onScroll);
  }, [store.viewMode.value]);

  useEffect(() => {
    if (store.viewMode.value !== "panel") return;
    const el = carouselRef.current;
    if (!el) return;
    const rubberMax = 40;

    function rubberBand(offset: number, limit: number): number {
      if (offset > 0) return limit > 0 ? 0 : rubberMax * (1 - Math.exp(-offset / (rubberMax * 3)));
      if (offset < limit) {
        const over = limit - offset;
        return limit - rubberMax * (1 - Math.exp(-over / (rubberMax * 3)));
      }
      return offset;
    }
    function onDragStart(x: number, y: number): boolean {
      if (store.zoomedDetId.value === null) return false;
      const wrapper = wrapperRefs.current[zoomRef.current.panelIdx];
      if (!wrapper) return false;
      dragRef.current = {
        startX: x, startY: y,
        startTx: zoomRef.current.tx, startTy: zoomRef.current.ty,
        wrapper,
      };
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
    function onMouseDown(e: MouseEvent) { if (onDragStart(e.clientX, e.clientY)) e.preventDefault(); }
    function onMouseMove(e: MouseEvent) { if (dragRef.current) { e.preventDefault(); onDragMove(e.clientX, e.clientY); } }
    function onTouchStart(e: TouchEvent) {
      if (store.zoomedDetId.value !== null && e.touches.length === 1) {
        onDragStart(e.touches[0].clientX, e.touches[0].clientY);
      }
    }
    function onTouchMove(e: TouchEvent) {
      if (dragRef.current) {
        e.preventDefault();
        onDragMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    }
    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onDragEnd);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onDragEnd);
    el.addEventListener("touchcancel", onDragEnd);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onDragEnd);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onDragEnd);
      el.removeEventListener("touchcancel", onDragEnd);
    };
  }, [store.viewMode.value]);

  function scrollToPanel(idx: number) {
    resetZoom();
    store.activePanel.value = idx;
    history.replaceState(null, "", `/app/photo/${event.id}/panel/${idx}${location.search}`);
    carouselRef.current?.scrollTo({ left: idx * (carouselRef.current?.clientWidth ?? 0), behavior: "smooth" });
  }

  function showPanel(idx: number) {
    store.viewMode.value = "panel";
    store.activePanel.value = idx;
    store.pinnedDetId.value = null;
    requestAnimationFrame(() => {
      carouselRef.current?.scrollTo({ left: idx * (carouselRef.current?.clientWidth ?? 0), behavior: "auto" });
    });
  }

  function showComic() {
    resetZoom();
    store.viewMode.value = "comic";
    store.pinnedDetId.value = null;
    store.resetUpscaleState();
  }

  function zoomToBbox(detId: number, panelIdx: number) {
    const wrapper = wrapperRefs.current[panelIdx];
    const canvas = canvasRefs.current[panelIdx];
    if (!wrapper || !canvas || !canvas.width) return;
    const slide = wrapper.parentElement;
    if (!slide) return;

    if (store.zoomedDetId.value === detId) {
      store.zoomedDetId.value = null;
      zoomRef.current = { ...EMPTY_ZOOM };
      applyZoom(wrapper, 0, 0, 1, true);
      wrapper.addEventListener("transitionend", () => { wrapper.style.transform = ""; }, { once: true });
      store.pinnedDetId.value = null;
      store.hoveredDetId.value = null;
      return;
    }

    const det = store.detections.value.find(candidate => candidate.id === detId);
    if (!det) return;
    const panel = PANELS[panelIdx];
    const localX = det.bbox_x - panel.x;
    const localY = det.bbox_y - panel.y;
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
    const tx = Math.max(viewW - canvas.clientWidth * zoom, Math.min(0, viewW / 2 - bboxCx * zoom));
    const ty = Math.max(viewH - canvas.clientHeight * zoom, Math.min(0, viewH / 2 - bboxCy * zoom));
    store.zoomedDetId.value = detId;
    store.pinnedDetId.value = detId;
    zoomRef.current = {
      tx, ty, zoom, panelIdx, viewW, viewH,
      contentW: canvas.clientWidth, contentH: canvas.clientHeight,
    };
    applyZoom(wrapper, tx, ty, zoom, true);
  }

  function resetZoom() {
    if (store.zoomedDetId.value === null) return;
    const wrapper = wrapperRefs.current[zoomRef.current.panelIdx];
    if (wrapper) {
      wrapper.style.transition = "";
      wrapper.style.transform = "";
    }
    store.zoomedDetId.value = null;
    zoomRef.current = { ...EMPTY_ZOOM };
  }

  function handleDetectionClick(det: Detection) {
    const panel = panelOf(det);
    if (panel < 0) return;
    if (store.viewMode.value === "comic") {
      showPanel(panel);
      requestAnimationFrame(() => requestAnimationFrame(() => zoomToBbox(det.id, panel)));
    } else if (panel !== store.activePanel.value) {
      resetZoom();
      scrollToPanel(panel);
      requestAnimationFrame(() => requestAnimationFrame(() => zoomToBbox(det.id, panel)));
    } else {
      zoomToBbox(det.id, panel);
    }
  }

  return {
    carouselRef, canvasRefs, wrapperRefs, hdProgressRef,
    scrollToPanel, showPanel, showComic, zoomToBbox, handleDetectionClick,
  };
}

function applyZoom(wrapper: HTMLElement, tx: number, ty: number, zoom: number, animated: boolean) {
  wrapper.style.transition = animated ? "transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)" : "none";
  wrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
}
