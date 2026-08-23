import { useRef, useCallback, useEffect } from 'preact/hooks';

export interface WebRTCState {
  connectionState: string;
}

export function useWebRTC(
  videoRef: preact.RefObject<HTMLVideoElement | null>,
  onError?: (error: Error) => void,
  onFirstFrame?: () => void,
) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const stateRef = useRef<string>('disconnected');
  const firstFrameCleanupRef = useRef<(() => void) | null>(null);

  // The media socket does not provide a reliable browser-close signal to the
  // server. Send the signaling session ID separately so a mode switch can
  // release the server-side UDP session immediately.
  const signalClose = useCallback((sessionId: string) => {
    const body = JSON.stringify({ session_id: sessionId });
    const beacon = typeof navigator !== 'undefined' && navigator.sendBeacon;

    // sendBeacon also works while the page is being unloaded. Fall back to a
    // keepalive fetch when the browser rejects the beacon queue.
    if (beacon) {
      try {
        const queued = navigator.sendBeacon(
          '/api/webrtc/close',
          new Blob([body], { type: 'application/json' }),
        );
        if (queued) return;
      } catch {
        // Fall through to fetch.
      }
    }

    void fetch('/api/webrtc/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  }, []);

  const stop = useCallback(() => {
    firstFrameCleanupRef.current?.();
    firstFrameCleanupRef.current = null;

    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (sessionId) signalClose(sessionId);
    const video = videoRef.current;
    if (video?.srcObject) {
      (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    stateRef.current = 'disconnected';
  }, [videoRef, signalClose]);

  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    // Clean up existing
    stop();

    let activePc: RTCPeerConnection | null = null;
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });
      activePc = pc;
      pcRef.current = pc;

      pc.ontrack = (event) => {
        if (event.track.kind === 'video') {
          video.srcObject = event.streams[0];

          // connectionState=connected only means that the transport is ready.
          // The browser still needs to receive and decode the first video
          // frame before the player is actually usable. Detect that frame so
          // the UI can dismiss its loading overlay at the right time.
          let firstFrameSeen = false;
          const markFirstFrame = () => {
            if (firstFrameSeen) return;
            firstFrameSeen = true;
            firstFrameCleanupRef.current?.();
            firstFrameCleanupRef.current = null;
            onFirstFrame?.();
          };

          const onLoadedData = () => markFirstFrame();
          const onPlaying = () => markFirstFrame();
          video.addEventListener('loadeddata', onLoadedData);
          video.addEventListener('playing', onPlaying);

          // requestVideoFrameCallback is the most precise signal when
          // available, while the events above cover older browsers.
          let frameCallbackId: number | null = null;
          if ('requestVideoFrameCallback' in video) {
            frameCallbackId = video.requestVideoFrameCallback(() => markFirstFrame());
          }

          firstFrameCleanupRef.current = () => {
            video.removeEventListener('loadeddata', onLoadedData);
            video.removeEventListener('playing', onPlaying);
            if (frameCallbackId !== null && 'cancelVideoFrameCallback' in video) {
              video.cancelVideoFrameCallback(frameCallbackId);
            }
          };
        }
      };

      pc.onconnectionstatechange = () => {
        stateRef.current = pc.connectionState;
        if (pc.connectionState === 'failed') {
          onError?.(new Error('WebRTC connection failed'));
          // A failed browser connection may stop sending packets without
          // closing the server UDP socket. Release it before falling back to
          // MJPEG rather than waiting for the keepalive timeout.
          if (pcRef.current === pc) stop();
        }
      };

      pc.addTransceiver('video', { direction: 'recvonly' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // The server is ICE-lite and advertises its candidates in the answer.
      // Send the offer immediately instead of blocking on local ICE gathering
      // completion. This removes the startup wait; the browser continues its
      // ICE checks after the answer arrives without adding media traffic.
      const localSDP = pc.localDescription?.sdp ?? offer.sdp;
      const response = await fetch(`${window.location.origin}/api/webrtc/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: localSDP, type: offer.type }),
      });

      if (!response.ok) {
        throw new Error(`Signaling failed: ${response.status}`);
      }

      const answer = await response.json() as {
        type: RTCSdpType;
        sdp: string;
        session_id?: string;
      };

      // A fast mode switch can stop this peer while its offer is in flight.
      // Close the newly-created server session instead of attaching it to a
      // stale peer connection.
      if (pcRef.current !== pc) {
        if (answer.session_id) signalClose(answer.session_id);
        return;
      }
      sessionIdRef.current = answer.session_id ?? null;
      await pc.setRemoteDescription(new RTCSessionDescription(answer));

      video.play().catch(() => {});
    } catch (error) {
      if (activePc && pcRef.current === activePc) stop();
      onError?.(error as Error);
    }
  }, [videoRef, stop, onError, onFirstFrame, signalClose]);

  const isConnected = useCallback(() => stateRef.current === 'connected', []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { start, stop, isConnected };
}
