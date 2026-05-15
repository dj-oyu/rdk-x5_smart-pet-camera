import { useRef, useCallback, useEffect } from 'preact/hooks';

export interface WebRTCState {
  connectionState: string;
}

export function useWebRTC(
  videoRef: preact.RefObject<HTMLVideoElement | null>,
  onError?: (error: Error) => void,
) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const stateRef = useRef<string>('disconnected');

  const stop = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    const video = videoRef.current;
    if (video?.srcObject) {
      (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    stateRef.current = 'disconnected';
  }, [videoRef]);

  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    // Clean up existing
    stop();

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });
      pcRef.current = pc;

      pc.ontrack = (event) => {
        if (event.track.kind === 'video') {
          video.srcObject = event.streams[0];
        }
      };

      pc.onconnectionstatechange = () => {
        stateRef.current = pc.connectionState;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          onError?.(new Error('WebRTC connection failed'));
        }
      };

      pc.addTransceiver('video', { direction: 'recvonly' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait until ICE gathering finishes so the SDP we POST contains all
      // host/srflx candidates inline. The server's /offer endpoint is
      // one-shot — no trickle channel — and Safari over LTE takes longer
      // than LAN to gather, so without this wait the offer goes out with
      // zero candidates and ICE never converges.
      if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            pc.removeEventListener('icegatheringstatechange', handler);
            resolve(); // proceed anyway — partial candidates beat hanging
          }, 5000);
          const handler = () => {
            if (pc.iceGatheringState === 'complete') {
              clearTimeout(timer);
              pc.removeEventListener('icegatheringstatechange', handler);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', handler);
        });
      }

      const localSDP = pc.localDescription?.sdp ?? offer.sdp;
      const response = await fetch(`${window.location.origin}/api/webrtc/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: localSDP, type: offer.type }),
      });

      if (!response.ok) {
        throw new Error(`Signaling failed: ${response.status}`);
      }

      const answer = await response.json();
      await pc.setRemoteDescription(new RTCSessionDescription(answer));

      video.play().catch(() => {});
    } catch (error) {
      onError?.(error as Error);
    }
  }, [videoRef, stop, onError]);

  const isConnected = useCallback(() => stateRef.current === 'connected', []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { start, stop, isConnected };
}
