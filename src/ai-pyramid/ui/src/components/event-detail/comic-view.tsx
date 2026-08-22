import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { photoUrl, type EventSummary } from "../../lib/api";
import type { DetailStore } from "../../lib/detail-store";

const COMIC_W = 848;
const COMIC_H = 496;

type Props = {
  event: EventSummary;
  store: DetailStore;
  onShowPanel: (panel: number) => void;
};

export function ComicView({ event, store, onShowPanel }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { scale, offsetX, offsetY } = useContainerScale(containerRef);

  return (
    <div class="detail-image-container" ref={containerRef} style={{ display: store.viewMode.value === "comic" ? "" : "none" }}>
      <img src={photoUrl(event.source_filename)} alt={event.summary ?? event.source_filename} class="detail-image" />
      {!store.scanning.value && store.detections.value.length > 0 && (
        <div
          class={`glass-overlay ${store.peekMode.value ? "peek" : ""}`}
          onMouseEnter={() => { store.peekMode.value = true; }}
          onMouseLeave={() => { store.peekMode.value = false; store.hoveredDetId.value = null; }}
        >
          {store.detections.value.map(det => (
            <div
              key={det.id}
              class={`glass-bbox ${store.activeDetId.value === det.id ? "highlighted" : ""} ${store.peekMode.value && store.activeDetId.value !== det.id ? "dimmed" : ""}`}
              style={{
                left: `${offsetX + det.bbox_x * scale}px`,
                top: `${offsetY + det.bbox_y * scale}px`,
                width: `${det.bbox_w * scale}px`,
                height: `${det.bbox_h * scale}px`,
              }}
            >
              <ShinePath width={det.bbox_w * scale} height={det.bbox_h * scale} />
              <ShinePath width={det.bbox_w * scale} height={det.bbox_h * scale} secondary />
            </div>
          ))}
        </div>
      )}
      {store.scanning.value && (
        <div class="glass-overlay scan-active">
          {store.smokeHits.value.map((hit, i) => (
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
      {!store.scanning.value && (
        <div class="comic-panel-regions" style={{
          left: `${offsetX}px`, top: `${offsetY}px`,
          width: `${COMIC_W * scale}px`, height: `${COMIC_H * scale}px`,
        }}>
          {[0, 1, 2, 3].map(i => (
            <button key={i} type="button" class="comic-panel-region" onClick={() => onShowPanel(i)} aria-label={`View panel ${i}`} />
          ))}
        </div>
      )}
    </div>
  );
}

function ShinePath({ width, height, secondary = false }: { width: number; height: number; secondary?: boolean }) {
  return (
    <span class={secondary ? "glass-shine glass-shine-b" : "glass-shine"} ref={el => {
      if (el) (el.style as any).offsetPath = `path("M 0,0 L ${width},0 L ${width},${height} L 0,${height} Z")`;
    }} />
  );
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
