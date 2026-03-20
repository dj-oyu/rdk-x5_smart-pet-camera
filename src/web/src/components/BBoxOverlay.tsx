import { useRef, useEffect, useCallback } from 'preact/hooks';
import type { Detection, DetectionEvent, StatusEvent } from '../lib/protobuf';

const COLORS: Record<string, string> = {
  cat: '#00FF00',
  dog: '#00C8FF',
  bird: '#FF9600',
  food_bowl: '#00A5FF',
  water_bowl: '#0078FF',
  motion: '#FF00FF',
  dish: '#FF0000',
  person: '#FFFF00',
  book: '#00FFFF',
  cell_phone: '#FF00FF',
  chair: '#8CB4FF',
  couch: '#B48CFF',
  tv: '#C8FF78',
  laptop: '#C8C8FF',
  remote: '#FFC878',
};

const STALE_THRESHOLD_MS = 1500;

export function useBBoxOverlay(videoRef: preact.RefObject<HTMLVideoElement | null>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const detectionsRef = useRef<Detection[]>([]);
  const lastEventTimeRef = useRef(0);
  const frameInfoRef = useRef({
    baseFrameNumber: 0,
    baseTime: 0,
    timestamp: 0,
    estimatedFps: 30,
  });
  const animIdRef = useRef(0);
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setupCanvas = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
    }
  }, [videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handler = () => setupCanvas();
    video.addEventListener('loadedmetadata', handler);
    video.addEventListener('resize', handler);
    video.addEventListener('canplay', handler);

    pollerRef.current = setInterval(() => {
      setupCanvas();
      const canvas = canvasRef.current;
      if (canvas && canvas.width > 0 && canvas.height > 0 && pollerRef.current) {
        clearInterval(pollerRef.current);
        pollerRef.current = null;
      }
    }, 100);

    const renderLoop = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const now = performance.now();

      if (lastEventTimeRef.current > 0 && now - lastEventTimeRef.current > STALE_THRESHOLD_MS) {
        if (detectionsRef.current.length > 0) {
          detectionsRef.current = [];
          lastEventTimeRef.current = now;
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const det of detectionsRef.current) {
        const color = COLORS[det.class_name] || '#FFFFFF';
        const scaleX = canvas.width / 1280;
        const scaleY = canvas.height / 720;
        const x = det.bbox.x * scaleX;
        const y = det.bbox.y * scaleY;
        const w = det.bbox.w * scaleX;
        const h = det.bbox.h * scaleY;

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);

        const label = `${det.class_name}: ${(det.confidence * 100).toFixed(0)}%`;
        ctx.font = '14px Arial';
        const metrics = ctx.measureText(label);
        const labelH = 18;
        const labelW = metrics.width + 8;
        const labelY = Math.max(y - labelH, 0);

        ctx.fillStyle = color;
        ctx.fillRect(x, labelY, labelW, labelH);
        ctx.fillStyle = '#000000';
        ctx.fillText(label, x + 4, labelY + 13);
      }

      const fi = frameInfoRef.current;
      let frameNum = fi.baseFrameNumber;
      let timestamp = fi.timestamp;
      if (fi.baseTime > 0 && fi.estimatedFps > 0) {
        const elapsedMs = now - fi.baseTime;
        frameNum = fi.baseFrameNumber + Math.floor((elapsedMs / 1000) * fi.estimatedFps);
        if (timestamp > 0) timestamp = fi.timestamp + elapsedMs / 1000;
      }

      let timeStr = '--';
      if (timestamp > 0) {
        const d = new Date(timestamp * 1000);
        const pad = (n: number) => String(n).padStart(2, '0');
        timeStr = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      }

      const digits = String(frameNum).length;
      const minDigits = Math.max(6, Math.ceil(digits / 2) * 2);
      const frameStr = String(frameNum).padStart(minDigits, ' ');
      const text = `Frame: ${frameStr}  Time: ${timeStr}`;

      ctx.font = '16px monospace';
      const charWidth = 9.6;
      const totalChars = 34 + minDigits;
      const bgWidth = totalChars * charWidth + 20;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(10, 10, bgWidth, 24);
      ctx.fillStyle = '#FFFF00';
      ctx.fillText(text, 15, 27);

      animIdRef.current = requestAnimationFrame(renderLoop);
    };

    animIdRef.current = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animIdRef.current);
      if (pollerRef.current) clearInterval(pollerRef.current);
      video.removeEventListener('loadedmetadata', handler);
      video.removeEventListener('resize', handler);
      video.removeEventListener('canplay', handler);
    };
  }, [videoRef, setupCanvas]);

  const handleDetection = useCallback((event: DetectionEvent) => {
    lastEventTimeRef.current = performance.now();
    detectionsRef.current = event.detections || [];
  }, []);

  const handleStatus = useCallback((event: StatusEvent) => {
    if (!event.shared_memory) return;
    let frameNumber = event.shared_memory.total_frames_written || 0;
    if (event.latest_detection) {
      const detFrame = event.latest_detection.frame_number || 0;
      if (detFrame > 0 && frameNumber - detFrame < 30) {
        frameNumber = detFrame;
      }
    }
    frameInfoRef.current = {
      baseFrameNumber: frameNumber,
      baseTime: performance.now(),
      timestamp: event.timestamp || 0,
      estimatedFps: event.monitor?.current_fps || 30,
    };
  }, []);

  return { canvasRef, handleDetection, handleStatus };
}
