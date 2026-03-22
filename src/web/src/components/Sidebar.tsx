import { useRef, useEffect, useState, useCallback } from 'preact/hooks';
import type { DetectionResult } from '../lib/protobuf';

const TRAJECTORY_COLORS: Record<string, [number, number, number]> = {
  cat: [110, 255, 160],
  dog: [255, 200, 120],
  bird: [160, 220, 255],
  food_bowl: [120, 200, 255],
  water_bowl: [255, 140, 140],
  dish: [150, 180, 255],
  person: [255, 240, 140],
  book: [200, 160, 255],
  cell_phone: [255, 160, 240],
  chair: [120, 190, 255],
  couch: [190, 150, 255],
  tv: [140, 255, 200],
  laptop: [160, 210, 255],
  remote: [255, 210, 150],
  bottle: [120, 255, 210],
  cup: [255, 190, 210],
};

interface TrajectoryPoint {
  x: number;
  y: number;
  rawX: number;
  rawY: number;
  className: string;
  color: [number, number, number];
}

const ALBUM_URL = 'https://<album-host>:8082/app';

export function useSidebar() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<TrajectoryPoint[]>([]);
  const lastKeyRef = useRef<string>('');
  const [legendEntries, setLegendEntries] = useState<[string, number][]>([]);

  const drawTrajectory = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 150;
    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.clearRect(0, 0, width, height);

    const points = pointsRef.current;
    if (points.length === 0) {
      ctx.fillStyle = 'rgba(154, 174, 211, 0.6)';
      ctx.font = '12px "Space Grotesk", sans-serif';
      ctx.fillText('no trajectory data', 10, height / 2);
      return;
    }

    let maxX = 0, maxY = 0;
    points.forEach((p) => { maxX = Math.max(maxX, p.rawX); maxY = Math.max(maxY, p.rawY); });
    const frameW = maxX || 1;
    const frameH = maxY || 1;

    const scaled = points.map((p) => ({
      x: (p.x / frameW) * width,
      y: (p.y / frameH) * height,
      color: p.color,
    }));

    for (let i = 1; i < scaled.length; i++) {
      const alpha = i / scaled.length;
      const [r, g, b] = scaled[i].color;
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(scaled[i - 1].x, scaled[i - 1].y);
      ctx.lineTo(scaled[i].x, scaled[i].y);
      ctx.stroke();
    }

    scaled.forEach((p, i) => {
      const alpha = (i + 1) / scaled.length;
      const [r, g, b] = p.color;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }, []);

  const updateTrajectory = useCallback(
    (latestDetection: DetectionResult | null) => {
      if (!latestDetection?.detections?.length) return;

      const key = `${latestDetection.frame_number}:${latestDetection.version}`;
      if (key === lastKeyRef.current) return;
      lastKeyRef.current = key;

      let best = latestDetection.detections[0];
      latestDetection.detections.forEach((d) => {
        if (d.confidence > best.confidence) best = d;
      });

      const cx = best.bbox.x + best.bbox.w / 2;
      const cy = best.bbox.y + best.bbox.h / 2;

      pointsRef.current.push({
        x: cx, y: cy,
        rawX: best.bbox.x + best.bbox.w,
        rawY: best.bbox.y + best.bbox.h,
        className: best.class_name,
        color: TRAJECTORY_COLORS[best.class_name] || [110, 231, 255],
      });
      if (pointsRef.current.length > 24) {
        pointsRef.current = pointsRef.current.slice(-24);
      }

      const counts: Record<string, number> = {};
      pointsRef.current.forEach((p) => { counts[p.className] = (counts[p.className] || 0) + 1; });
      setLegendEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5));

      drawTrajectory();
    },
    [drawTrajectory],
  );

  useEffect(() => {
    const handler = () => drawTrajectory();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [drawTrajectory]);

  return { canvasRef, legendEntries, updateTrajectory };
}

export function SidebarView(props: ReturnType<typeof useSidebar>) {
  const [albumOffline, setAlbumOffline] = useState(false);
  const [albumHeight, setAlbumHeight] = useState(0);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxMeta, setLightboxMeta] = useState<{ date?: string; pet?: string; behavior?: string; caption?: string }>({});

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'album-height' && typeof e.data.height === 'number') {
        setAlbumHeight(e.data.height);
      }
      if (e.data?.type === 'album-lightbox' && typeof e.data.src === 'string') {
        setLightboxSrc(e.data.src);
        setLightboxMeta(e.data.meta || {});
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (!lightboxSrc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxSrc(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxSrc]);

  return (
    <div class="sidebar">
      <div class="trajectory-card">
        <canvas class="trajectory-canvas" ref={props.canvasRef} />
        <div class="legend">
          {props.legendEntries.length === 0 ? (
            <span class="legend-empty">No data</span>
          ) : (
            props.legendEntries.map(([name]) => {
              const color = TRAJECTORY_COLORS[name] || [110, 231, 255];
              return (
                <span class="legend-item" key={name}>
                  <span class="legend-swatch" style={{ background: `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.9)` }} />
                  <span>{name}</span>
                </span>
              );
            })
          )}
        </div>
      </div>

      <div class="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>アルバム</h2>
          <a href={ALBUM_URL} target="_blank" class="album-link" title="別タブで開く">↗</a>
        </div>
        {albumOffline ? (
          <div class="album-offline">アルバムサービスに接続できません</div>
        ) : (
          <iframe
            src={ALBUM_URL}
            class="album-iframe"
            scrolling="auto"
            style={albumHeight ? { height: `${albumHeight}px` } : undefined}
            onError={() => setAlbumOffline(true)}
          />
        )}
      </div>

      {lightboxSrc && (
        <div class="album-lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="Full size" />
          <div class="album-lightbox-meta" onClick={(e) => e.stopPropagation()}>
            {lightboxMeta.date && <span class="album-lightbox-date">{lightboxMeta.date}</span>}
            {lightboxMeta.pet && <span class={`album-lightbox-pet ${lightboxMeta.pet}`}>{lightboxMeta.pet}</span>}
            {lightboxMeta.behavior && <span class="album-lightbox-behavior">{lightboxMeta.behavior}</span>}
            {lightboxMeta.caption && <p class="album-lightbox-caption">{lightboxMeta.caption}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
