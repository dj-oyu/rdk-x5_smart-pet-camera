import { useRef, useEffect, useState, useCallback } from 'preact/hooks';
import type { DetectionResult } from '../lib/protobuf';
import { classRgb } from '../lib/detection-classes';

interface TrajectoryPoint {
  x: number;
  y: number;
  className: string;
  confidence: number;
  color: [number, number, number];
}

interface GanttRecord {
  timestamp: number;
  classes: string[];
}

const GANTT_WINDOW = 24 * 60 * 60; // 24 hours in seconds
const GANTT_GAP_THRESHOLD = 30; // merge gaps shorter than 30s

const ALBUM_URL = 'https://m5stack-ai-pyramid.tail848eb5.ts.net:8082/app?embed=petcamera';

export function useSidebar() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ganttCanvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<TrajectoryPoint[]>([]);
  const ganttRef = useRef<GanttRecord[]>([]);
  const lastKeyRef = useRef<string>('');
  const heatmapRef = useRef<{ grid: number[][]; baseValid: boolean; roiX: number; roiY: number; roiW: number; roiH: number }>({ grid: [], baseValid: false, roiX: 0, roiY: 0, roiW: 1280, roiH: 720 });
  const [legendEntries, setLegendEntries] = useState<[string, number][]>([]);
  const [ganttClasses, setGanttClasses] = useState<string[]>([]);

  // Poll base_diff heatmap from detector API
  useEffect(() => {
    let active = true;
    const poll = () => {
      if (!active) return;
      fetch('/api/base_diff')
        .then((r) => r.json())
        .then((data) => {
          if (data.grid && data.grid.length > 0) {
            heatmapRef.current = {
              grid: data.grid,
              baseValid: data.base_valid,
              roiX: data.roi_x ?? 0,
              roiY: data.roi_y ?? 0,
              roiW: data.roi_w ?? 1280,
              roiH: data.roi_h ?? 720,
            };
          }
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 500);
    return () => { active = false; clearInterval(id); };
  }, []);

  const drawTrajectory = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.clientWidth || 320;
    // Force 16:9 aspect ratio matching 1280x720 video
    const height = Math.round(width * 9 / 16);
    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.clearRect(0, 0, width, height);

    // ── Draw base_diff heatmap as background ──
    const { grid, baseValid, roiX, roiY, roiW, roiH } = heatmapRef.current;
    if (baseValid && grid.length > 0) {
      const rows = grid.length;
      const cols = grid[0].length;
      // Softmax-style normalization: relative contrast within grid
      const maxV = Math.max(...grid.flat());
      const normalized = grid.map(row => row.map(v => {
        if (maxV < 0.005) return 0;  // all near-zero → no heatmap
        return Math.min(1, (v / maxV) ** 0.5);  // sqrt for gamma expansion
      }));
      // Map ROI grid cells to canvas coordinates (ROI covers part of 1280x720)
      const frameW = 1280;
      const frameH = 720;
      const cellW = (roiW / frameW * width) / cols;
      const cellH = (roiH / frameH * height) / rows;
      const offsetX = roiX / frameW * width;
      const offsetY = roiY / frameH * height;
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          const v = normalized[gy][gx];
          if (v < 0.05) continue;
          const r = Math.round(255 * v);
          const g = Math.round(80 * (1 - v));
          const b = Math.round(255 * (1 - v));
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.2 + v * 0.6})`;
          ctx.fillRect(offsetX + gx * cellW, offsetY + gy * cellH, cellW, cellH);
        }
      }
    }

    const points = pointsRef.current;
    if (points.length === 0 && !baseValid) {
      ctx.fillStyle = 'rgba(154, 174, 211, 0.6)';
      ctx.font = '12px "Space Grotesk", sans-serif';
      ctx.fillText('no trajectory data', 10, height / 2);
      return;
    }

    const frameW = 1280;
    const frameH = 720;

    const scaled = points.map((p) => ({
      x: (p.x / frameW) * width,
      y: (p.y / frameH) * height,
      confidence: p.confidence,
      color: p.color,
    }));

    for (let i = 1; i < scaled.length; i++) {
      const age = i / scaled.length;
      const dx = scaled[i].x - scaled[i - 1].x;
      const dy = scaled[i].y - scaled[i - 1].y;
      const speed = Math.min(Math.sqrt(dx * dx + dy * dy) / 50, 1);
      const alpha = age * (0.5 + speed * 0.5);
      const [r, g, b] = scaled[i].color;
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.lineWidth = 1 + scaled[i].confidence * 3;
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
      ctx.arc(p.x, p.y, 2 + p.confidence * 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }, []);

  const drawGantt = useCallback(() => {
    const canvas = ganttCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const records = ganttRef.current;
    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 120;
    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.clearRect(0, 0, width, height);

    // Collect classes
    const classSet = new Set<string>();
    records.forEach((r) => r.classes.forEach((c) => classSet.add(c)));
    const classes = [...classSet].sort();

    if (classes.length === 0) {
      ctx.fillStyle = 'rgba(154, 174, 211, 0.6)';
      ctx.font = '12px "Space Grotesk", sans-serif';
      ctx.fillText('no detection history', 10, height / 2);
      return;
    }

    const now = Date.now() / 1000;
    const windowStart = now - GANTT_WINDOW;
    const labelWidth = 70;
    const chartLeft = labelWidth;
    const chartWidth = width - labelWidth - 8;
    const rowHeight = Math.min(20, (height - 24) / classes.length);
    const topMargin = 4;

    // Time axis labels
    ctx.fillStyle = 'rgba(154, 174, 211, 0.5)';
    ctx.font = '10px "Space Grotesk", sans-serif';
    for (let h = 0; h <= 24; h += 6) {
      const t = windowStart + h * 3600;
      const x = chartLeft + (t - windowStart) / GANTT_WINDOW * chartWidth;
      const d = new Date(t * 1000);
      const label = `${String(d.getHours()).padStart(2, '0')}:00`;
      ctx.fillText(label, x - 12, height - 2);
      // Grid line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.beginPath();
      ctx.moveTo(x, topMargin);
      ctx.lineTo(x, height - 16);
      ctx.stroke();
    }

    // Now marker
    const nowX = chartLeft + chartWidth;
    ctx.strokeStyle = 'rgba(110, 231, 255, 0.4)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(nowX, topMargin);
    ctx.lineTo(nowX, height - 16);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw rows
    classes.forEach((cls, i) => {
      const y = topMargin + i * rowHeight;
      const color = classRgb(cls);

      // Class label
      ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.8)`;
      ctx.font = '11px "Space Grotesk", sans-serif';
      ctx.fillText(cls, 4, y + rowHeight * 0.7);

      // Build spans: merge records within GAP_THRESHOLD
      const timestamps = records
        .filter((r) => r.classes.includes(cls))
        .map((r) => r.timestamp);

      if (timestamps.length === 0) return;

      const spans: [number, number][] = [];
      let spanStart = timestamps[0];
      let spanEnd = timestamps[0];
      for (let j = 1; j < timestamps.length; j++) {
        if (timestamps[j] - spanEnd <= GANTT_GAP_THRESHOLD) {
          spanEnd = timestamps[j];
        } else {
          spans.push([spanStart, spanEnd]);
          spanStart = timestamps[j];
          spanEnd = timestamps[j];
        }
      }
      spans.push([spanStart, spanEnd]);

      // Draw bars
      ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.5)`;
      for (const [start, end] of spans) {
        const x1 = chartLeft + (start - windowStart) / GANTT_WINDOW * chartWidth;
        const x2 = chartLeft + (end - windowStart) / GANTT_WINDOW * chartWidth;
        const barW = Math.max(x2 - x1, 2); // minimum 2px
        ctx.fillRect(x1, y + 2, barW, rowHeight - 4);
      }
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
        className: best.class_name,
        confidence: best.confidence,
        color: classRgb(best.class_name),
      });
      if (pointsRef.current.length > 24) {
        pointsRef.current = pointsRef.current.slice(-24);
      }

      // Gantt: record all detected classes at this timestamp
      const now = Date.now() / 1000;
      const allClasses = latestDetection.detections.map((d) => d.class_name);
      const uniqueClasses = [...new Set(allClasses)];
      ganttRef.current.push({ timestamp: now, classes: uniqueClasses });

      // Trim old records beyond 24h window
      const cutoff = now - GANTT_WINDOW;
      while (ganttRef.current.length > 0 && ganttRef.current[0].timestamp < cutoff) {
        ganttRef.current.shift();
      }

      // Update known classes for Gantt y-axis
      const classSet = new Set<string>();
      ganttRef.current.forEach((r) => r.classes.forEach((c) => classSet.add(c)));
      const sorted = [...classSet].sort();
      setGanttClasses((prev) => {
        if (prev.length === sorted.length && prev.every((c, i) => c === sorted[i])) return prev;
        return sorted;
      });

      const counts: Record<string, number> = {};
      pointsRef.current.forEach((p) => { counts[p.className] = (counts[p.className] || 0) + 1; });
      setLegendEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5));

      drawTrajectory();
      drawGantt();
    },
    [drawTrajectory, drawGantt],
  );

  // Fetch 24h history on mount
  useEffect(() => {
    fetch('/api/detections/history')
      .then((r) => r.json())
      .then((records: { timestamp: number; classes: string[] }[]) => {
        if (Array.isArray(records) && records.length > 0) {
          ganttRef.current = records;
          const classSet = new Set<string>();
          records.forEach((r) => r.classes.forEach((c: string) => classSet.add(c)));
          setGanttClasses([...classSet].sort());
          drawGantt();
        }
      })
      .catch(() => {});
  }, [drawGantt]);

  useEffect(() => {
    const handler = () => { drawTrajectory(); drawGantt(); };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [drawTrajectory, drawGantt]);

  return { canvasRef, ganttCanvasRef, legendEntries, ganttClasses, updateTrajectory };
}

export type MobileTab = 'live' | 'tracking' | 'album';

export function TrackingView(props: Pick<ReturnType<typeof useSidebar>, 'canvasRef' | 'ganttCanvasRef' | 'legendEntries'>) {
  return (
    <div class="tracking-section">
      <div class="trajectory-card">
        <canvas class="trajectory-canvas" ref={props.canvasRef} />
        <div class="legend">
          {props.legendEntries.length === 0 ? (
            <span class="legend-empty">No data</span>
          ) : (
            props.legendEntries.map(([name]) => {
              const color = classRgb(name);
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
      <div class="gantt-card">
        <canvas class="gantt-canvas" ref={props.ganttCanvasRef} />
      </div>
    </div>
  );
}

export function AlbumView() {
  const [albumOffline, setAlbumOffline] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxMeta, setLightboxMeta] = useState<{ date?: string; pet?: string; behavior?: string; caption?: string }>({});

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'album-lightbox' && typeof e.data.src === 'string') {
        setLightboxSrc(e.data.src);
        setLightboxMeta(e.data.meta || {});
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (lightboxSrc) {
      document.body.classList.add('lightbox-active');
    } else {
      document.body.classList.remove('lightbox-active');
    }
    if (!lightboxSrc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxSrc(null);
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.classList.remove('lightbox-active');
    };
  }, [lightboxSrc]);

  return (
    <>
      <div class="panel album-panel">
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
    </>
  );
}
