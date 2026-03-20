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

    const BOUNDARY = '--frame\r\n';
    const HEADER_END = '\r\n\r\n';

    fetch('/stream?t=' + Date.now(), { signal: ac.signal })
      .then(res => {
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        let pending = '';

        const pump = (): Promise<void> => reader.read().then(({ done, value }) => {
          if (done || ac.signal.aborted) return;
          pending += new TextDecoder().decode(value, { stream: true });

          // Extract JPEG frames from multipart/x-mixed-replace
          let bIdx: number;
          while ((bIdx = pending.indexOf(BOUNDARY)) !== -1) {
            const afterBoundary = bIdx + BOUNDARY.length;
            const hEnd = pending.indexOf(HEADER_END, afterBoundary);
            if (hEnd === -1) break; // incomplete header
            const dataStart = hEnd + HEADER_END.length;

            // Parse Content-Length from headers
            const headers = pending.slice(afterBoundary, hEnd);
            const clMatch = headers.match(/Content-Length:\s*(\d+)/i);
            if (!clMatch) { pending = pending.slice(afterBoundary); continue; }
            const contentLength = parseInt(clMatch[1], 10);

            // Check if full JPEG body is available (binary length != string length)
            // Use binary view for accurate byte counting
            const bodyStr = pending.slice(dataStart);
            const bodyBytes = new TextEncoder().encode(bodyStr);
            if (bodyBytes.length < contentLength) break; // wait for more data

            // Extract exact JPEG bytes
            const jpeg = bodyBytes.slice(0, contentLength);
            const blob = new Blob([jpeg], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            const prev = img.src;
            img.src = url;
            if (prev) URL.revokeObjectURL(prev);

            // Advance past this frame (convert consumed bytes back to string length)
            const consumed = new TextDecoder().decode(bodyBytes.slice(0, contentLength));
            pending = pending.slice(dataStart + consumed.length);
          }
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
