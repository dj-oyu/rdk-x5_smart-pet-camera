import { useRef, useEffect, useCallback } from 'preact/hooks';
import { base64ToBytes, decodeDetectionEvent, decodeStatusEvent } from '../lib/protobuf';
import type { DetectionEvent, StatusEvent } from '../lib/protobuf';

interface SSEOptions {
  onDetection?: (event: DetectionEvent) => void;
  onStatus?: (event: StatusEvent) => void;
  onViewerCount?: (count: number) => void;
}

export function useSSE(options: SSEOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const detectionESRef = useRef<EventSource | null>(null);
  const statusESRef = useRef<EventSource | null>(null);
  const connectionESRef = useRef<EventSource | null>(null);

  const startDetectionStream = useCallback(() => {
    detectionESRef.current?.close();
    const es = new EventSource('/api/detections/stream?format=protobuf');
    detectionESRef.current = es;

    es.onmessage = (event) => {
      try {
        const bytes = base64ToBytes(event.data);
        const parsed = decodeDetectionEvent(bytes);
        optionsRef.current.onDetection?.(parsed);
      } catch (e) {
        console.error('[SSE] Detection decode error:', e);
      }
    };
    es.onerror = () => {
      es.close();
      setTimeout(startDetectionStream, 2000);
    };
  }, []);

  const startStatusStream = useCallback((retryCount = 0) => {
    statusESRef.current?.close();
    const es = new EventSource('/api/status/stream?format=protobuf');
    statusESRef.current = es;

    es.onmessage = (event) => {
      try {
        const bytes = base64ToBytes(event.data);
        const data = decodeStatusEvent(bytes);
        optionsRef.current.onStatus?.(data);
      } catch (e) {
        console.error('[SSE] Status decode error:', e);
      }
    };
    es.onerror = () => {
      es.close();
      if (retryCount < 3) {
        setTimeout(() => startStatusStream(retryCount + 1), 1000 * Math.pow(2, retryCount));
      } else {
        // Fallback to polling
        const poll = async () => {
          try {
            const res = await fetch('/api/status');
            if (res.ok) {
              const data = await res.json();
              optionsRef.current.onStatus?.(data);
            }
          } catch { /* ignore */ }
        };
        poll();
        setInterval(poll, 2000);
      }
    };
  }, []);

  const startConnectionStream = useCallback((retryCount = 0) => {
    connectionESRef.current?.close();
    const es = new EventSource('/api/connections/stream');
    connectionESRef.current = es;

    es.addEventListener('connections', (event: Event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        const viewers = (data.webrtc || 0) + (data.mjpeg || 0);
        optionsRef.current.onViewerCount?.(viewers);
      } catch { /* ignore */ }
    });
    es.onerror = () => {
      es.close();
      if (retryCount < 3) {
        setTimeout(() => startConnectionStream(retryCount + 1), 1000 * Math.pow(2, retryCount));
      }
    };

    // Initial fetch
    fetch('/api/connections')
      .then((r) => r.json())
      .then((data) => {
        const viewers = (data.webrtc || 0) + (data.mjpeg || 0);
        optionsRef.current.onViewerCount?.(viewers);
      })
      .catch(() => {});
  }, []);

  const stop = useCallback(() => {
    detectionESRef.current?.close();
    statusESRef.current?.close();
    connectionESRef.current?.close();
    detectionESRef.current = null;
    statusESRef.current = null;
    connectionESRef.current = null;
  }, []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { startDetectionStream, startStatusStream, startConnectionStream, stop };
}
