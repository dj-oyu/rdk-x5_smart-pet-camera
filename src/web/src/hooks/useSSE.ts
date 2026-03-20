import { useRef, useEffect, useCallback } from 'preact/hooks';
import { base64ToBytes, decodeDetectionEvent, decodeStatusEvent } from '../lib/protobuf';
import type { DetectionEvent, StatusEvent } from '../lib/protobuf';

interface SSEOptions {
  onDetection?: (event: DetectionEvent) => void;
  onStatus?: (event: StatusEvent) => void;
  onViewerCount?: (count: number) => void;
}

function createSSE(
  url: string,
  ac: AbortController,
  onMessage: (data: string) => void,
  onReconnect: (retry: number) => void,
  eventName?: string,
) {
  const es = new EventSource(url);
  let retryCount = 0;

  const handler = (event: Event) => {
    retryCount = 0;
    onMessage((event as MessageEvent).data);
  };

  if (eventName) {
    es.addEventListener(eventName, handler);
  } else {
    es.onmessage = (e) => { retryCount = 0; onMessage(e.data); };
  }

  es.onerror = () => {
    es.close();
    if (ac.signal.aborted) return;
    retryCount++;
    if (retryCount <= 5) {
      const delay = 1000 * Math.pow(2, retryCount - 1);
      setTimeout(() => {
        if (!ac.signal.aborted) onReconnect(retryCount);
      }, delay);
    }
  };

  // Abort → close
  ac.signal.addEventListener('abort', () => es.close());
  return es;
}

export function useSSE(options: SSEOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const acRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    acRef.current?.abort();
    acRef.current = null;
  }, []);

  const start = useCallback(() => {
    // Abort any existing connections first
    stop();
    const ac = new AbortController();
    acRef.current = ac;

    // Detection SSE
    const startDetection = (retry = 0) => {
      if (ac.signal.aborted) return;
      createSSE(
        '/api/detections/stream?format=protobuf', ac,
        (data) => {
          try {
            optionsRef.current.onDetection?.(decodeDetectionEvent(base64ToBytes(data)));
          } catch { /* ignore */ }
        },
        (r) => startDetection(r),
      );
    };

    // Status SSE
    const startStatus = (retry = 0) => {
      if (ac.signal.aborted) return;
      createSSE(
        '/api/status/stream?format=protobuf', ac,
        (data) => {
          try {
            optionsRef.current.onStatus?.(decodeStatusEvent(base64ToBytes(data)));
          } catch { /* ignore */ }
        },
        (r) => startStatus(r),
      );
    };

    // Connection SSE (named event)
    const parseViewers = (data: string) => {
      try {
        const d = JSON.parse(data);
        optionsRef.current.onViewerCount?.((d.webrtc || 0) + (d.mjpeg || 0));
      } catch { /* ignore */ }
    };

    const startConnection = (retry = 0) => {
      if (ac.signal.aborted) return;
      createSSE(
        '/api/connections/stream', ac,
        parseViewers,
        (r) => startConnection(r),
        'connections',
      );
    };

    startDetection();
    startStatus();
    startConnection();

    // Initial viewer count fetch
    fetch('/api/connections', { signal: ac.signal })
      .then((r) => r.json())
      .then((d) => parseViewers(JSON.stringify(d)))
      .catch(() => {});
  }, [stop]);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { start, stop };
}
