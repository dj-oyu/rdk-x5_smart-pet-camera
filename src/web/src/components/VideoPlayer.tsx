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

  // MJPEG via fetch + AbortController: explicit connection lifecycle
  const startMJPEG = useCallback(() => {
    stopMJPEG();
    const ac = new AbortController();
    mjpegAcRef.current = ac;
    const img = mjpegRef.current;
    if (!img) return;

    // Fallback: just set src directly (multipart/x-mixed-replace is browser-native)
    // But wrap in AbortController-aware fetch to detect abort
    img.src = '/stream?t=' + Date.now();

    // Listen for abort to clear img src and close HTTP connection
    ac.signal.addEventListener('abort', () => {
      img.src = '';
      img.removeAttribute('src');
    });
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

  useEffect(() => {
    webrtc.start();
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
    switchToWebRTC,
    switchToMJPEG,
    mjpegRef,
    handleDetection: wrappedDetection,
    handleStatus: wrappedStatus,
  };
}
