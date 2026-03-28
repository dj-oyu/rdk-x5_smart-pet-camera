import { useRef, useCallback, useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { useWebRTC } from '../hooks/useWebRTC';
import { useBBoxOverlay } from './BBoxOverlay';
import type { DetectionEvent, StatusEvent } from '../lib/protobuf';

interface UseVideoPlayerOptions {
  onDetection?: (event: DetectionEvent) => void;
  onStatus?: (event: StatusEvent) => void;
}

export function useVideoPlayer(options: UseVideoPlayerOptions = {}) {
  const mode = useSignal<'webrtc' | 'mjpeg'>('webrtc');
  const videoRef = useRef<HTMLVideoElement>(null);
  const mjpegRef = useRef<HTMLImageElement>(null);
  const fallbackAttempted = useRef(false);

  const { canvasRef, handleDetection, handleStatus } = useBBoxOverlay(videoRef);

  // Stop MJPEG: replace src with 1px GIF + DOM detach to force connection close
  // iOS Safari ignores img.src='' but loading a new resource aborts the stream
  const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const stopMJPEG = useCallback(() => {
    const img = mjpegRef.current;
    if (img) {
      // 1) Load a data URI to abort the multipart HTTP request
      img.src = BLANK_GIF;
      // 2) DOM detach/reattach as additional measure
      const parent = img.parentNode;
      const next = img.nextSibling;
      if (parent) parent.removeChild(img);
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
        // peek() で signal を読んでも subscription を作らない
        if (mode.peek() === 'webrtc') {
          mode.value = 'mjpeg';
          startMJPEG();
        }
      }, 2000);
    }
  }, [startMJPEG]);

  const webrtc = useWebRTC(videoRef, onWebRTCError);

  const switchToMJPEG = useCallback(() => {
    if (mode.peek() === 'mjpeg') return;
    mode.value = 'mjpeg';
    webrtc.stop();
    startMJPEG();
  }, [webrtc, startMJPEG]);

  const switchToWebRTC = useCallback(async () => {
    if (mode.peek() === 'webrtc') return;
    mode.value = 'webrtc';
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
