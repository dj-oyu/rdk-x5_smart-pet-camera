import { useState, useRef, useCallback } from 'preact/hooks';
import { useWebRTC } from '../hooks/useWebRTC';
import { BBoxOverlay } from './BBoxOverlay';
import type { DetectionEvent, StatusEvent } from '../lib/protobuf';

interface Props {
  onDetection?: (event: DetectionEvent) => void;
  onStatus?: (event: StatusEvent) => void;
}

export function VideoPlayer({ onDetection, onStatus }: Props) {
  const [mode, setMode] = useState<'webrtc' | 'mjpeg'>('webrtc');
  const videoRef = useRef<HTMLVideoElement>(null);
  const mjpegRef = useRef<HTMLImageElement>(null);

  const { canvasRef, handleDetection, handleStatus } = BBoxOverlay({ videoRef });

  const switchToMJPEG = useCallback(() => {
    setMode('mjpeg');
    webrtc.stop();
    const img = mjpegRef.current;
    if (img && (!img.src || !img.src.includes('/stream'))) {
      img.src = '/stream?t=' + Date.now();
    }
  }, []);

  const onWebRTCError = useCallback(() => {
    setTimeout(switchToMJPEG, 2000);
  }, [switchToMJPEG]);

  const webrtc = useWebRTC(videoRef, onWebRTCError);

  const switchToWebRTC = useCallback(async () => {
    setMode('webrtc');
    // Stop MJPEG - force close HTTP connection
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
  const initialized = useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    // Use microtask to start after render
    queueMicrotask(() => webrtc.start());
  }

  // Expose handlers for SSE to feed into
  const wrappedDetection = useCallback(
    (event: DetectionEvent) => {
      handleDetection(event);
      onDetection?.(event);
    },
    [handleDetection, onDetection],
  );

  const wrappedStatus = useCallback(
    (event: StatusEvent) => {
      handleStatus(event);
      onStatus?.(event);
    },
    [handleStatus, onStatus],
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
