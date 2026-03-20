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

const COMICS_PAGE_SIZE = 6;

function parseComicDate(filename: string): Date | null {
  const match = filename.match(/comic_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  return new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
}

function formatDate(date: Date | null): string {
  if (!date) return '--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function useSidebar(onOpenThumbnail: (url: string, name: string) => void) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<TrajectoryPoint[]>([]);
  const lastKeyRef = useRef<string>('');
  const [legendEntries, setLegendEntries] = useState<[string, number][]>([]);

  const [comics, setComics] = useState<string[]>([]);
  const [comicsTotal, setComicsTotal] = useState(0);
  const comicsOffsetRef = useRef(0);
  const galleryRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

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

  const fetchComicsPage = async (offset: number, limit: number) => {
    const res = await fetch(`/api/comics?limit=${limit}&offset=${offset}`);
    if (!res.ok) throw new Error('Failed to fetch comics');
    return (await res.json()) as { comics: { filename: string }[]; total: number };
  };

  const loadInitialComics = useCallback(async () => {
    try {
      const data = await fetchComicsPage(0, COMICS_PAGE_SIZE);
      setComicsTotal(data.total || 0);
      const filenames = (data.comics || []).map((c) => c.filename);
      comicsOffsetRef.current = filenames.length;
      setComics(filenames);
    } catch (e) {
      console.error('[Comics] Fetch error:', e);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || comicsOffsetRef.current >= comicsTotal) return;
    loadingRef.current = true;
    try {
      const data = await fetchComicsPage(comicsOffsetRef.current, COMICS_PAGE_SIZE);
      const filenames = (data.comics || []).map((c) => c.filename);
      comicsOffsetRef.current += filenames.length;
      setComicsTotal(data.total || comicsTotal);
      setComics((prev) => [...prev, ...filenames]);
    } catch (e) {
      console.error('[Comics] Load more error:', e);
    } finally {
      loadingRef.current = false;
    }
  }, [comicsTotal]);

  useEffect(() => {
    loadInitialComics();
    const id = setInterval(loadInitialComics, 30000);
    return () => clearInterval(id);
  }, [loadInitialComics]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const gallery = galleryRef.current;
    if (!sentinel || !gallery || comicsOffsetRef.current >= comicsTotal) return;

    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { root: gallery, rootMargin: '0px 200px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [comics.length, comicsTotal, loadMore]);

  const deleteComic = useCallback(async (filename: string) => {
    if (!confirm(`Delete "${filename}"?`)) return;
    try {
      const res = await fetch(`/api/comics/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      if (res.ok) {
        setComics((prev) => prev.filter((c) => c !== filename));
        setComicsTotal((t) => t - 1);
        comicsOffsetRef.current--;
      } else {
        const data = await res.json();
        alert('Delete failed: ' + (data.error || 'Unknown error'));
      }
    } catch { alert('Delete failed'); }
  }, []);

  return { canvasRef, legendEntries, comics, comicsTotal, galleryRef, sentinelRef, updateTrajectory, deleteComic, onOpenThumbnail };
}

export function SidebarView(props: ReturnType<typeof useSidebar>) {
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
          <div>
            <h2>アルバム</h2>
          </div>
        </div>
        <div class="comic-gallery" ref={props.galleryRef}>
          {props.comics.length === 0 ? (
            <p class="muted">まだ写真がありません。ねこの検出を待っています。</p>
          ) : (
            <>
              {props.comics.map((filename) => {
                const date = parseComicDate(filename);
                const imgUrl = `/api/comics/${encodeURIComponent(filename)}`;
                return (
                  <div class="comic-card" key={filename} data-filename={filename}>
                    <img src={imgUrl} alt={filename} loading="lazy" onClick={() => props.onOpenThumbnail(imgUrl, filename)} />
                    <div class="comic-card-footer">
                      <span class="comic-card-date">{formatDate(date)}</span>
                      <button class="btn-delete comic-card-delete" onClick={(e) => { e.stopPropagation(); props.deleteComic(filename); }} title="Delete">&times;</button>
                    </div>
                  </div>
                );
              })}
              {props.comics.length < props.comicsTotal && (
                <div class="load-sentinel" ref={props.sentinelRef} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
