import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { useWebRTC } from '../hooks/useWebRTC';
import { useBBoxOverlay } from './BBoxOverlay';
import type { DetectionEvent, StatusEvent } from '../lib/protobuf';

interface UseVideoPlayerOptions {
  onDetection?: (event: DetectionEvent) => void;
  onStatus?: (event: StatusEvent) => void;
}

export function useVideoPlayer(options: UseVideoPlayerOptions = {}) {
  const [mode, setMode] = useState<'webrtc' | 'mjpeg'>('webrtc');
  const videoRef = useRef<HTMLVideoElement>(null);
  const mjpegRef = useRef<HTMLImageElement>(null);
  const modeRef = useRef<'webrtc' | 'mjpeg'>('webrtc');
  const fallbackAttempted = useRef(false);
  const mjpegAcRef = useRef<AbortController | null>(null);

  const { canvasRef, handleDetection, handleStatus } = useBBoxOverlay(videoRef);

  // Stop MJPEG: abort fetch (ReadableStream mode) or detach img from DOM (fallback mode)
  const stopMJPEG = useCallback(() => {
    mjpegAcRef.current?.abort();
    mjpegAcRef.current = null;
    const img = mjpegRef.current;
    if (img) {
      // DOM detach forces browser to close the underlying TCP connection
      // (img.src='' alone is unreliable on iOS Safari)
      const parent = img.parentNode;
      const next = img.nextSibling;
      if (parent) parent.removeChild(img);
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = '';
      img.removeAttribute('src');
      if (parent) parent.insertBefore(img, next);
    }
  }, []);

  // MJPEG start: try fetch+ReadableStream, fallback to img.src for iOS Safari
  const startMJPEG = useCallback(() => {
    stopMJPEG();
    const ac = new AbortController();
    mjpegAcRef.current = ac;
    const img = mjpegRef.current;
    if (!img) return;

    const url = '/stream?t=' + Date.now();

    // Try fetch + ReadableStream (works on Chrome/Firefox, reliable abort)
    fetch(url, { signal: ac.signal })
      .then(res => {
        if (!res.ok) return;
        // If ReadableStream not available (iOS Safari), fall back to img.src
        if (!res.body) {
          img.src = url;
          return;
        }
        const reader = res.body.getReader();
        let buf = new Uint8Array(0);

        const BOUNDARY = new TextEncoder().encode('--frame\r\n');
        const CRLFCRLF = new TextEncoder().encode('\r\n\r\n');

        const findBytes = (haystack: Uint8Array, needle: Uint8Array, from = 0): number => {
          for (let i = from; i <= haystack.length - needle.length; i++) {
            let match = true;
            for (let j = 0; j < needle.length; j++) {
              if (haystack[i + j] !== needle[j]) { match = false; break; }
            }
            if (match) return i;
          }
          return -1;
        };

        const pump = (): Promise<void> => reader.read().then(({ done, value }) => {
          if (done || ac.signal.aborted) return;
          const tmp = new Uint8Array(buf.length + value.length);
          tmp.set(buf);
          tmp.set(value, buf.length);
          buf = tmp;

          let consumed = 0;
          while (true) {
            const bIdx = findBytes(buf, BOUNDARY, consumed);
            if (bIdx === -1) break;
            const afterB = bIdx + BOUNDARY.length;
            const hEnd = findBytes(buf, CRLFCRLF, afterB);
            if (hEnd === -1) break;
            const dataStart = hEnd + CRLFCRLF.length;

            const headerStr = new TextDecoder().decode(buf.slice(afterB, hEnd));
            const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
            if (!clMatch) { consumed = afterB; continue; }
            const contentLength = parseInt(clMatch[1], 10);
            if (buf.length < dataStart + contentLength) break;

            const jpeg = buf.slice(dataStart, dataStart + contentLength);
            const blob = new Blob([jpeg], { type: 'image/jpeg' });
            const objUrl = URL.createObjectURL(blob);
            const prev = img.src;
            img.src = objUrl;
            if (prev) URL.revokeObjectURL(prev);

            let next = dataStart + contentLength;
            if (next + 2 <= buf.length && buf[next] === 13 && buf[next + 1] === 10) next += 2;
            consumed = next;
          }
          if (consumed > 0) buf = buf.slice(consumed);
          return pump();
        });
        return pump();
      })
      .catch(() => { /* aborted or network error */ });
  }, [stopMJPEG]);

  const onWebRTCError = useCallback(() => {
    if (!fallbackAttempted.current) {
      fallbackAttempted.current = true;
      setTimeout(() => {
        if (modeRef.current === 'webrtc') {
          modeRef.current = 'mjpeg';
          setMode('mjpeg');
          startMJPEG();
        }
      }, 2000);
    }
  }, [startMJPEG]);

  const webrtc = useWebRTC(videoRef, onWebRTCError);

  const switchToMJPEG = useCallback(() => {
    if (modeRef.current === 'mjpeg') return;
    modeRef.current = 'mjpeg';
    setMode('mjpeg');
    webrtc.stop();
    startMJPEG();
  }, [webrtc, startMJPEG]);

  const switchToWebRTC = useCallback(async () => {
    if (modeRef.current === 'webrtc') return;
    modeRef.current = 'webrtc';
    setMode('webrtc');
    stopMJPEG();
    fallbackAttempted.current = false;
    if (!webrtc.isConnected()) {
      await webrtc.start();
    }
  }, [webrtc, stopMJPEG]);

  // Expose startWebRTC for parent to call after DOM mount
  const startWebRTC = useCallback(() => {
    webrtc.start().catch(() => {});
  }, [webrtc]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      webrtc.stop();
      stopMJPEG();
    };
  }, []);

  const wrappedDetection = useCallback(
    (event: DetectionEvent) => {
      handleDetection(event);
      options.onDetection?.(event);
    },
    [handleDetection, options.onDetection],
  );

  const wrappedStatus = useCallback(
    (event: StatusEvent) => {
      handleStatus(event);
      options.onStatus?.(event);
    },
    [handleStatus, options.onStatus],
  );

  return {
    videoRef,
    canvasRef,
    mode,
    startWebRTC,
    switchToWebRTC,
    switchToMJPEG,
    mjpegRef,
    handleDetection: wrappedDetection,
    handleStatus: wrappedStatus,
  };
}
