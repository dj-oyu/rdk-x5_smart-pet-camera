/**
 * WebRTC Video Client
 *
 * WebRTCを使ってサーバーからH.264ストリームを受信し、
 * HTMLVideoElementで再生する
 */

export class WebRTCVideoClient {
    /**
     * @param {HTMLVideoElement} videoElement - Video element for playback
     * @param {string} signalingUrl - WebRTC signaling server URL
     */
    constructor(videoElement, signalingUrl = null) {
        this.videoElement = videoElement;
        // Use same origin by default (Flask app is on same port)
        this.signalingUrl = signalingUrl || window.location.origin;
        this.pc = null;
        this.connectionState = 'disconnected';

        // Event callbacks
        this.onConnectionStateChange = null;
        this.onError = null;
    }

    /**
     * Start WebRTC connection
     * @returns {Promise<void>}
     */
    async start() {
        try {
            console.log('[WebRTC] Starting connection...');

            // Create RTCPeerConnection
            this.pc = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' }
                ],
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require'
            });

            // Handle incoming tracks
            this.pc.ontrack = (event) => {
                console.log('[WebRTC] Received track:', event.track.kind);
                if (event.track.kind === 'video') {
                    this.videoElement.srcObject = event.streams[0];
                    console.log('[WebRTC] Video track assigned to element');
                }
            };

            // Handle connection state changes
            this.pc.onconnectionstatechange = () => {
                this.connectionState = this.pc.connectionState;
                console.log('[WebRTC] Connection state:', this.connectionState);

                if (this.onConnectionStateChange) {
                    this.onConnectionStateChange(this.connectionState);
                }

                if (this.connectionState === 'failed' || this.connectionState === 'closed') {
                    console.error('[WebRTC] Connection failed or closed');
                    if (this.onError) {
                        this.onError(new Error('WebRTC connection failed'));
                    }
                }
            };

            // Handle ICE connection state
            this.pc.oniceconnectionstatechange = () => {
                console.log('[WebRTC] ICE connection state:', this.pc.iceConnectionState);
            };

            // Handle ICE candidates
            this.pc.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log('[WebRTC] New ICE candidate');
                    // In a full implementation, send this to the server
                    // For now, STUN should handle most cases
                }
            };

            // Create offer
            const offer = await this.pc.createOffer({
                offerToReceiveVideo: true,
                offerToReceiveAudio: false
            });

            // Set local description
            await this.pc.setLocalDescription(offer);
            console.log('[WebRTC] Local description set');

            // Send offer to server
            const response = await fetch(`${this.signalingUrl}/api/webrtc/offer`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    sdp: offer.sdp,
                    type: offer.type
                })
            });

            if (!response.ok) {
                throw new Error(`Signaling failed: ${response.status} ${response.statusText}`);
            }

            const answer = await response.json();
            console.log('[WebRTC] Received answer from server');

            // Set remote description
            await this.pc.setRemoteDescription(
                new RTCSessionDescription(answer)
            );
            console.log('[WebRTC] Remote description set');

            // Start video playback
            this.videoElement.play().catch(e => {
                console.warn('[WebRTC] Autoplay prevented:', e);
                // User interaction required for playback
            });

            console.log('[WebRTC] Connection established successfully');

        } catch (error) {
            console.error('[WebRTC] Error starting connection:', error);
            if (this.onError) {
                this.onError(error);
            }
            throw error;
        }
    }

    /**
     * Stop WebRTC connection
     */
    stop() {
        console.log('[WebRTC] Stopping connection...');

        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        if (this.videoElement.srcObject) {
            this.videoElement.srcObject.getTracks().forEach(track => track.stop());
            this.videoElement.srcObject = null;
        }

        this.connectionState = 'disconnected';
        console.log('[WebRTC] Connection stopped');
    }

    /**
     * Check if connected
     * @returns {boolean}
     */
    isConnected() {
        return this.connectionState === 'connected';
    }

    /**
     * Get current connection state
     * @returns {string}
     */
    getConnectionState() {
        return this.connectionState;
    }
}
