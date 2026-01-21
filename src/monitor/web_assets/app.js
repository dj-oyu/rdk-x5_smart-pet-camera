/**
 * Main application entry point
 * Initializes WebRTC video streaming with MJPEG fallback
 */

import { WebRTCVideoClient } from './webrtc_client.js';
import { BBoxOverlay } from './bbox_overlay.js';

// Elements
const video = document.getElementById('webrtc-video');
const canvas = document.getElementById('bbox-canvas');
const webrtcView = document.getElementById('webrtc-view');
const mjpegView = document.getElementById('mjpeg-view');
const btnWebrtc = document.getElementById('btn-webrtc');
const btnMjpeg = document.getElementById('btn-mjpeg');

// WebRTC client and overlay
let webrtcClient = null;
let bboxOverlay = null;
let currentMode = 'webrtc';  // 'webrtc' or 'mjpeg'

// Initialize WebRTC
async function initWebRTC() {
    try {
        console.log('[App] Initializing WebRTC...');

        // Create WebRTC client (use same origin as current page)
        webrtcClient = new WebRTCVideoClient(video);

        // Connection state callback
        webrtcClient.onConnectionStateChange = (state) => {
            console.log('[App] WebRTC state:', state);
        };

        // Error callback
        webrtcClient.onError = (error) => {
            console.error('[App] WebRTC error:', error);
            // Auto-fallback to MJPEG on error
            setTimeout(() => switchToMJPEG(), 2000);
        };

        // Start connection
        await webrtcClient.start();
        console.log('[App] WebRTC connection initiated');

        // Initialize BBox overlay with performance callback
        bboxOverlay = new BBoxOverlay(video, canvas, {
            onStatsUpdate: (stats) => {
                if (window.updatePerformanceMetrics) {
                    window.updatePerformanceMetrics(stats);
                }
            }
        });
        bboxOverlay.start();
        console.log('[App] BBox overlay started');

    } catch (error) {
        console.error('[App] WebRTC initialization failed:', error);
        // Fallback to MJPEG
        setTimeout(() => switchToMJPEG(), 2000);
    }
}

// Switch to MJPEG
function switchToMJPEG() {
    console.log('[App] Switching to MJPEG...');
    currentMode = 'mjpeg';

    // Stop WebRTC
    if (webrtcClient) {
        webrtcClient.stop();
    }
    if (bboxOverlay) {
        bboxOverlay.stop();
    }

    // Show MJPEG, hide WebRTC
    webrtcView.style.display = 'none';
    mjpegView.style.display = 'block';

    // Start MJPEG stream (set src triggers browser HTTP connection -> Go Subscribe)
    const streamImg = document.getElementById('stream');
    if (!streamImg.src || !streamImg.src.includes('/stream')) {
        streamImg.src = '/stream?t=' + Date.now(); // Cache buster
        console.log('[MJPEG] Started stream (browser HTTP connection)');
    }

    // Update UI
    btnWebrtc.classList.remove('active');
    btnMjpeg.classList.add('active');
}

// Switch to WebRTC
async function switchToWebRTC() {
    console.log('[App] Switching to WebRTC...');
    currentMode = 'webrtc';

    // Stop MJPEG stream (clear src closes browser HTTP connection -> Go Unsubscribe)
    const streamImg = document.getElementById('stream');
    if (streamImg.src) {
        streamImg.src = '';
        console.log('[MJPEG] Stopped stream (browser closed HTTP connection)');
    }

    // Show WebRTC, hide MJPEG
    webrtcView.style.display = 'block';
    mjpegView.style.display = 'none';

    // Update UI
    btnWebrtc.classList.add('active');
    btnMjpeg.classList.remove('active');

    // Initialize WebRTC if not already running
    if (!webrtcClient || !webrtcClient.isConnected()) {
        await initWebRTC();
    }
}

// Button handlers
btnWebrtc.addEventListener('click', switchToWebRTC);
btnMjpeg.addEventListener('click', switchToMJPEG);

// Start with WebRTC
window.addEventListener('load', () => {
    console.log('[App] Page loaded, starting WebRTC...');
    initWebRTC();
});
