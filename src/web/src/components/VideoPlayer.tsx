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

  const { canvasRef, handleDetection, handleStatus } = useBBoxOverlay(videoRef);

  // Stop MJPEG: detach img from DOM to force TCP connection closure
  // (img.src='' alone is unreliable on mobile browsers)
  const stopMJPEG = useCallback(() => {
    const img = mjpegRef.current;
    if (img) {
      const parent = img.parentNode;
      const next = img.nextSibling;
      if (parent) parent.removeChild(img);
      img.src = '';
      img.removeAttribute('src');
      if (parent) parent.insertBefore(img, next);
    }
  }, []);

  // MJPEG start: native img.src (universal browser support)
  const startMJPEG = useCallback(() => {
    stopMJPEG();
    const img = mjpegRef.current;
    if (!img) return;
    img.src = '/stream?t=' + Date.now();
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
