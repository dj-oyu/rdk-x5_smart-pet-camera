import type { RefObject } from "preact";
import { bboxColor, classTier, panelOf, PANELS, PW, type DetailStore } from "../../lib/detail-store";

type Props = {
  store: DetailStore;
  carouselRef: RefObject<HTMLDivElement>;
  canvases: (HTMLCanvasElement | null)[];
  wrappers: (HTMLDivElement | null)[];
  hdProgressRef: RefObject<HTMLDivElement>;
  onScrollToPanel: (panel: number) => void;
  onZoomToBbox: (detectionId: number, panel: number) => void;
};

export function PanelCarousel({
  store, carouselRef, canvases, wrappers, hdProgressRef,
  onScrollToPanel, onZoomToBbox,
}: Props) {
  return (
    <div class="carousel-wrapper">
      <div class="panel-carousel" ref={carouselRef}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} class="panel-slide" data-panel={i}>
            <div class="zoom-wrapper" ref={el => { wrappers[i] = el; }}>
              <canvas ref={el => { canvases[i] = el; }} style={{ width: "100%", height: "auto" }} />
              {store.detections.value.length > 0 && (
                <div class="bbox-overlay">
                  {store.visibleDets.value.filter(det => panelOf(det) === i).map(det => {
                    const style = panelBboxStyle(det, i, canvases[i]);
                    if (!style) return null;
                    const tier = classTier(det);
                    return (
                      <div
                        key={det.id}
                        class={`bbox tier-${tier} ${store.activeDetId.value === det.id ? "highlighted" : ""} ${store.zoomedDetId.value === det.id ? "zoom-target" : ""} ${store.activeDetId.value !== null && store.activeDetId.value !== det.id ? "dimmed" : ""}`}
                        style={style}
                        onMouseEnter={() => { store.hoveredDetId.value = det.id; }}
                        onMouseLeave={() => { store.hoveredDetId.value = null; }}
                        onClick={e => { e.stopPropagation(); onZoomToBbox(det.id, i); }}
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
      {store.activePanel.value > 0 && (
        <button type="button" class="carousel-nav-btn prev" onClick={() => onScrollToPanel(store.activePanel.value - 1)}>&#8249;</button>
      )}
      {store.activePanel.value < 3 && (
        <button type="button" class="carousel-nav-btn next" onClick={() => onScrollToPanel(store.activePanel.value + 1)}>&#8250;</button>
      )}
      <div class="carousel-dots">
        {[0, 1, 2, 3].map(i => (
          <button key={i} type="button" class={`panel-dot ${i === store.activePanel.value ? "active" : ""}`} onClick={() => onScrollToPanel(i)} />
        ))}
      </div>
      <button
        type="button"
        class={`hd-btn ${store.hdLoading.value ? "loading" : ""} ${store.upscaleState.value[store.activePanel.value] === "hd" ? "done" : ""}`}
        onClick={() => {
          if (store.hdLoading.value) return;
          store.toggleUpscale(store.activePanel.value, canvases, hdProgressRef.current);
        }}
      >HD</button>
      <div class="hd-progress" ref={hdProgressRef} style={{ width: 0 }} />
      {store.upscaleState.value[store.activePanel.value] && (
        <span class="upscale-badge">{store.upscaleState.value[store.activePanel.value] === "hd" ? "4× HD" : "4× fast"}</span>
      )}
    </div>
  );
}

function panelBboxStyle(
  det: { bbox_x: number; bbox_y: number; bbox_w: number; bbox_h: number },
  panelIdx: number,
  canvas: HTMLCanvasElement | null,
): Record<string, string> | null {
  if (!canvas || !canvas.width) return null;
  const panel = PANELS[panelIdx];
  const mult = canvas.width > PW ? canvas.width / PW : 1;
  const scaleX = canvas.clientWidth / canvas.width;
  const scaleY = canvas.clientHeight / canvas.height;
  return {
    left: `${(det.bbox_x - panel.x) * mult * scaleX}px`,
    top: `${(det.bbox_y - panel.y) * mult * scaleY}px`,
    width: `${det.bbox_w * mult * scaleX}px`,
    height: `${det.bbox_h * mult * scaleY}px`,
  };
}
