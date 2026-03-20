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

  const stopMJPEG = useCallback(() => {
    mjpegAcRef.current?.abort();
    mjpegAcRef.current = null;
    const img = mjpegRef.current;
    if (img) {
      if (img.src) URL.revokeObjectURL(img.src);
      img.removeAttribute('src');
    }
  }, []);

  // MJPEG via fetch + ReadableStream: abort() kills TCP connection immediately
  // (img.src approach leaks connections on mobile browsers)
  const startMJPEG = useCallback(() => {
    stopMJPEG();
    const ac = new AbortController();
    mjpegAcRef.current = ac;
    const img = mjpegRef.current;
    if (!img) return;

    // Byte patterns for multipart boundary parsing
    const BOUNDARY = new TextEncoder().encode('--frame\r\n');
    const CRLFCRLF = new TextEncoder().encode('\r\n\r\n');
    const CRLF = new TextEncoder().encode('\r\n');

    const findBytes = (haystack: Uint8Array, needle: Uint8Array, from = 0): number => {
      outer: for (let i = from; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
      }
      return -1;
    };

    fetch('/stream?t=' + Date.now(), { signal: ac.signal })
      .then(res => {
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        let buf = new Uint8Array(0);

        const pump = (): Promise<void> => reader.read().then(({ done, value }) => {
          if (done || ac.signal.aborted) return;

          // Append chunk
          const tmp = new Uint8Array(buf.length + value.length);
          tmp.set(buf);
          tmp.set(value, buf.length);
          buf = tmp;

          // Extract JPEG frames from multipart/x-mixed-replace (all binary)
          let consumed = 0;
          while (true) {
            const bIdx = findBytes(buf, BOUNDARY, consumed);
            if (bIdx === -1) break;
            const afterBoundary = bIdx + BOUNDARY.length;
            const hEnd = findBytes(buf, CRLFCRLF, afterBoundary);
            if (hEnd === -1) break;
            const dataStart = hEnd + CRLFCRLF.length;

            // Parse Content-Length from ASCII headers
            const headerStr = new TextDecoder().decode(buf.slice(afterBoundary, hEnd));
            const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
            if (!clMatch) { consumed = afterBoundary; continue; }
            const contentLength = parseInt(clMatch[1], 10);

            if (buf.length < dataStart + contentLength) break; // incomplete body

            // Extract JPEG bytes and display
            const jpeg = buf.slice(dataStart, dataStart + contentLength);
            const blob = new Blob([jpeg], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            const prev = img.src;
            img.src = url;
            if (prev) URL.revokeObjectURL(prev);

            // Skip trailing CRLF after body
            let next = dataStart + contentLength;
            if (next + CRLF.length <= buf.length &&
                buf[next] === 13 && buf[next + 1] === 10) {
              next += CRLF.length;
            }
            consumed = next;
          }
          if (consumed > 0) buf = buf.slice(consumed);
          return pump();
        });
        return pump();
      })
      .catch(() => { /* aborted or network error - expected */ });
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
