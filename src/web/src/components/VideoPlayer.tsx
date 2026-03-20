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

  const { canvasRef, handleDetection, handleStatus } = useBBoxOverlay(videoRef);

  const switchToMJPEGRef = useRef<() => void>(() => {});

  const onWebRTCError = useCallback(() => {
    setTimeout(() => switchToMJPEGRef.current(), 2000);
  }, []);

  const webrtc = useWebRTC(videoRef, onWebRTCError);

  const switchToMJPEG = useCallback(() => {
    setMode('mjpeg');
    webrtc.stop();
    const img = mjpegRef.current;
    if (img && (!img.src || !img.src.includes('/stream'))) {
      img.src = '/stream?t=' + Date.now();
    }
  }, [webrtc]);

  switchToMJPEGRef.current = switchToMJPEG;

  const switchToWebRTC = useCallback(async () => {
    setMode('webrtc');
    const img = mjpegRef.current;
    if (img?.src?.includes('/stream')) {
      const parent = img.parentNode!;
      const next = img.nextSibling;
      parent.removeChild(img);
      img.src = '';
      img.removeAttribute('src');
      parent.insertBefore(img, next);
    }
    if (!webrtc.isConnected()) {
      await webrtc.start();
    }
  }, [webrtc]);

  // Start WebRTC on mount
  useEffect(() => {
    webrtc.start();
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
