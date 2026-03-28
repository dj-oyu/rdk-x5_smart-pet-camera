import { useRef, useEffect, useCallback } from 'preact/hooks';
import { useSignal } from '@preact/signals';
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
const ECG_WINDOW = 5 * 60; // 5 minutes in seconds

// ── Lightweight bbox tracker ──
const TRACK_MATCH_DIST = 120; // max center-to-center pixels to match (in 1280x720 frame coords)
const TRACK_GRACE_SEC = 3;    // keep track alive for N seconds after last match

interface Track {
  id: number;
  cls: string;
  cx: number;
  cy: number;
  lastSeen: number; // epoch seconds
}

let nextTrackId = 1;

function matchTracks(
  tracks: Track[],
  detections: { cx: number; cy: number; cls: string; conf: number }[],
  now: number,
): { trackId: number; cls: string; conf: number }[] {
  const result: { trackId: number; cls: string; conf: number }[] = [];
  const used = new Set<number>(); // track indices already matched

  // Greedy nearest-neighbor: for each detection, find closest same-class track
  for (const det of detections) {
    let bestIdx = -1;
    let bestDist = TRACK_MATCH_DIST;
    for (let i = 0; i < tracks.length; i++) {
      if (used.has(i)) continue;
      if (tracks[i].cls !== det.cls) continue;
      const dx = tracks[i].cx - det.cx;
      const dy = tracks[i].cy - det.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      // Update existing track
      used.add(bestIdx);
      tracks[bestIdx].cx = det.cx;
      tracks[bestIdx].cy = det.cy;
      tracks[bestIdx].lastSeen = now;
      result.push({ trackId: tracks[bestIdx].id, cls: det.cls, conf: det.conf });
    } else {
      // New track
      const id = nextTrackId++;
      tracks.push({ id, cls: det.cls, cx: det.cx, cy: det.cy, lastSeen: now });
      result.push({ trackId: id, cls: det.cls, conf: det.conf });
    }
  }

  // Expire stale tracks
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (now - tracks[i].lastSeen > TRACK_GRACE_SEC) {
      tracks.splice(i, 1);
    }
  }

  return result;
}

export function useSidebar() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ganttCanvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<TrajectoryPoint[]>([]);
  const ganttRef = useRef<GanttRecord[]>([]);
  const lastKeyRef = useRef<string>('');
  const heatmapRef = useRef<{ grid: number[][]; baseValid: boolean; scoreThreshold?: number }>({ grid: [], baseValid: false });
  const confHistoryRef = useRef<{ ts: number; bboxes: { trackId: number; conf: number; cls: string }[]; th: number }[]>([]);
  const tracksRef = useRef<Track[]>([]);
  const legendEntries = useSignal<[string, number][]>([]);
  const ganttClasses = useSignal<string[]>([]);

  // SSE-based heatmap updates (replaces polling)
  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    // Initial fetch for immediate display
    fetch('/api/base_diff')
      .then((r) => r.json())
      .then((data) => {
        heatmapRef.current = {
          grid: data.grid ?? [],
          baseValid: data.base_valid ?? false,
          scoreThreshold: data.score_threshold,
        };
        drawTrajectory();
      })
      .catch(() => {});

    const connect = () => {
      if (closed) return;
      es = new EventSource('/api/base_diff/stream');
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          heatmapRef.current = {
            grid: data.grid ?? [],
            baseValid: data.base_valid ?? false,
            scoreThreshold: data.score_threshold,
          };
          drawTrajectory();
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        es?.close();
        if (!closed) setTimeout(connect, 3000);
      };
    };
    connect();

    return () => { closed = true; es?.close(); };
  }, []); // drawTrajectory is stable (useCallback with []), no need to list

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

    // ── Draw confidence area chart as background (time-based, per-class) ──
    const history = confHistoryRef.current;
    if (history.length > 1) {
      const now = history[history.length - 1].ts;
      const tStart = now - ECG_WINDOW;
      const toX = (ts: number) => ((ts - tStart) / ECG_WINDOW) * width;
      const toY = (conf: number) => height * (1 - conf);

      // Y-axis grid lines (0.2 increments)
      ctx.strokeStyle = 'rgba(154, 174, 211, 0.12)';
      ctx.lineWidth = 0.5;
      for (let v = 0.2; v <= 0.8; v += 0.2) {
        const gy = toY(v);
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(width, gy);
        ctx.stroke();
      }

      // Group bboxes by trackId — each track gets its own line/area
      const trackPts = new Map<number, { x: number; y: number; age: number; cls: string }[]>();
      const trackLastSeen = new Map<number, number>();
      for (const frame of history) {
        for (const b of frame.bboxes) {
          if (!trackPts.has(b.trackId)) trackPts.set(b.trackId, []);
          trackPts.get(b.trackId)!.push({
            x: toX(frame.ts),
            y: toY(b.conf),
            age: (frame.ts - tStart) / ECG_WINDOW,
            cls: b.cls,
          });
          trackLastSeen.set(b.trackId, frame.ts);
        }
      }

      // Sort tracks: older last-seen first (drawn first = behind), newer on top
      const sortedTracks = [...trackPts.keys()].sort(
        (a, b) => (trackLastSeen.get(a) ?? 0) - (trackLastSeen.get(b) ?? 0)
      );

      // Per-track: area fill + line + dots (color from class)
      for (const tid of sortedTracks) {
        const pts = trackPts.get(tid)!;
        const color = classRgb(pts[0].cls);

        // Area fill with class-colored gradient
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.18)`);
        grad.addColorStop(1, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.01)`);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, height);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(pts[pts.length - 1].x, height);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Confidence line
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.45)`;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Dots
        for (const p of pts) {
          ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${0.25 + p.age * 0.55})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Adaptive threshold line (drawn on top of all classes)
      const scoreTh = heatmapRef.current.scoreThreshold;
      if (scoreTh !== undefined && scoreTh > 0) {
        const thY = toY(scoreTh);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255, 100, 100, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, thY);
        ctx.lineTo(width, thY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    const points = pointsRef.current;
    if (points.length === 0 && history.length === 0) {
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

      // Confidence history for area chart — track-aware, time-based
      const ecgNow = Date.now() / 1000;
      const th = heatmapRef.current.scoreThreshold ?? 0.4;
      const dets = latestDetection.detections.map((d) => ({
        cx: d.bbox.x + d.bbox.w / 2,
        cy: d.bbox.y + d.bbox.h / 2,
        cls: d.class_name,
        conf: d.confidence,
      }));
      const tracked = matchTracks(tracksRef.current, dets, ecgNow);
      confHistoryRef.current.push({ ts: ecgNow, bboxes: tracked, th });
      // Trim to 5-minute window
      const ecgCutoff = ecgNow - ECG_WINDOW;
      while (confHistoryRef.current.length > 0 && confHistoryRef.current[0].ts < ecgCutoff) {
        confHistoryRef.current.shift();
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

      // Update known classes for Gantt y-axis (object comparison を避けてノイズを抑制)
      const classSet = new Set<string>();
      ganttRef.current.forEach((r) => r.classes.forEach((c) => classSet.add(c)));
      const sorted = [...classSet].sort();
      const prev = ganttClasses.value;
      if (prev.length !== sorted.length || !prev.every((c, i) => c === sorted[i])) {
        ganttClasses.value = sorted;
      }

      const counts: Record<string, number> = {};
      pointsRef.current.forEach((p) => { counts[p.className] = (counts[p.className] || 0) + 1; });
      legendEntries.value = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);

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
          ganttClasses.value = [...classSet].sort();
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

export type { MobileTab } from '../lib/store';

export function TrackingView(props: Pick<ReturnType<typeof useSidebar>, 'canvasRef' | 'ganttCanvasRef'> & { legendEntries: [string, number][] }) {
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

