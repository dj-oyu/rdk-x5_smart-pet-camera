/**
 * BBox Overlay Renderer
 *
 * ビデオ上にバウンディングボックスをオーバーレイ描画
 * Server-Sent Eventsで検出結果をリアルタイム受信
 * Protobuf/JSON両形式対応
 */

import { decodeDetectionEvent, decodeStatusEvent, base64ToBytes } from './protobuf_decoder.js';

// 色定義（web_monitor.pyと同じ）
const COLORS = {
    'cat': '#00FF00',        // 緑
    'dog': '#00C8FF',        // オレンジ寄り
    'bird': '#FF9600',       // 青寄り
    'food_bowl': '#00A5FF',  // オレンジ
    'water_bowl': '#0078FF', // 青
    'dish': '#FF0000',       // 赤
    'person': '#FFFF00',     // シアン
    'book': '#00FFFF',       // 黄色
    'cell_phone': '#FF00FF', // マゼンタ
    'chair': '#8CB4FF',
    'couch': '#B48CFF',
    'tv': '#C8FF78',
    'laptop': '#C8C8FF',
    'remote': '#FFC878',
};

export class BBoxOverlay {
    /**
     * @param {HTMLVideoElement} videoElement - Source video element
     * @param {HTMLCanvasElement} canvasElement - Canvas for overlay
     * @param {Object} options - Configuration options
     * @param {string} options.format - 'protobuf' (default, efficient) or 'json'
     * @param {Function} options.onStatsUpdate - Callback for stats updates
     */
    constructor(videoElement, canvasElement, options = {}) {
        this.video = videoElement;
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d');

        // Format configuration: protobuf is default (more efficient)
        this.format = options.format || 'protobuf';
        this.onStatsUpdate = options.onStatsUpdate || null;

        // Detection state
        this.currentDetections = []; // Current frame's detections (no smoothing)
        this.latestDetection = null;
        this.detectionEventSource = null;
        this.statusEventSource = null;

        // Frame info from status SSE (updated independently of detections)
        this.frameInfo = {
            frameNumber: 0,
            timestamp: 0,
            lastUpdateTime: 0,
            // For smooth interpolation between SSE updates
            baseFrameNumber: 0,
            baseTime: 0,
            estimatedFps: 30
        };

        // Animation control
        this.animationId = null;
        this.isRunning = false;

        // Stale detection threshold
        this.STALE_THRESHOLD_MS = 1500; // Clear detections after this many ms without events (YOLO runs ~2FPS)

        // Stats
        this.stats = {
            framesRendered: 0,
            lastUpdateTime: 0,
            renderFps: 0,
            eventsReceived: 0,
            bytesReceived: 0,
            lastEventTime: 0
        };

        this._setupCanvas();
    }

    _setupCanvas() {
        const updateCanvasSize = () => {
            if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
                this.canvas.width = this.video.videoWidth;
                this.canvas.height = this.video.videoHeight;
                console.log(`[BBox] Canvas sized to ${this.canvas.width}x${this.canvas.height}`);
            }
        };
        this.video.addEventListener('loadedmetadata', updateCanvasSize);
        updateCanvasSize();
    }

    start() {
        if (this.isRunning) {
            console.warn('[BBox] Already running');
            return;
        }
        console.log('[BBox] Starting overlay renderer...');
        this._connectDetectionSSE();
        this._connectStatusSSE();
        this.isRunning = true;
        this._renderLoop();
        console.log('[BBox] Overlay renderer started');
    }

    stop() {
        console.log('[BBox] Stopping overlay renderer...');
        this.isRunning = false;

        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        if (this.detectionEventSource) {
            this.detectionEventSource.close();
            this.detectionEventSource = null;
        }
        if (this.statusEventSource) {
            this.statusEventSource.close();
            this.statusEventSource = null;
        }
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        console.log('[BBox] Overlay renderer stopped');
    }

    _connectDetectionSSE() {
        // Construct URL with format query parameter
        const baseUrl = '/api/detections/stream';
        const url = this.format === 'protobuf' ? `${baseUrl}?format=protobuf` : baseUrl;

        console.log(`[BBox] Connecting to detection SSE: ${url}`);
        this.detectionEventSource = new EventSource(url);

        this.detectionEventSource.onmessage = (event) => {
            this._handleDetectionData(event.data);
        };
        this.detectionEventSource.onerror = (error) => {
            console.error('[BBox] Detection SSE error:', error);
        };
        this.detectionEventSource.onopen = () => {
            console.log(`[BBox] Detection SSE connected (${this.format})`);
            this.stats.bytesReceived = 0;
            this.stats.eventsReceived = 0;
        };
    }

    _connectStatusSSE() {
        // Status SSE for frame info (updates every 2s regardless of detections)
        const baseUrl = '/api/status/stream';
        const url = this.format === 'protobuf' ? `${baseUrl}?format=protobuf` : baseUrl;

        console.log(`[BBox] Connecting to status SSE: ${url}`);
        this.statusEventSource = new EventSource(url);

        this.statusEventSource.onmessage = (event) => {
            this._handleStatusData(event.data);
        };
        this.statusEventSource.onerror = (error) => {
            console.error('[BBox] Status SSE error:', error);
        };
        this.statusEventSource.onopen = () => {
            console.log(`[BBox] Status SSE connected`);
        };
    }

    _handleDetectionData(data) {
        try {
            this.stats.eventsReceived++;
            this.stats.bytesReceived += data.length;
            this.stats.lastEventTime = performance.now();

            let parsed;
            if (this.format === 'protobuf') {
                const bytes = base64ToBytes(data);
                parsed = decodeDetectionEvent(bytes);
            } else {
                parsed = JSON.parse(data);
            }

            let newDetections = [];
            if (parsed.detections) {
                newDetections = parsed.detections;
                this.latestDetection = parsed;
            } else if (parsed.latest_detection?.detections) {
                newDetections = parsed.latest_detection.detections;
                this.latestDetection = parsed.latest_detection;
            }

            const frameNum = parsed.frame_number || parsed.latest_detection?.frame_number || 0;
            if (frameNum % 30 === 0) {
                const fmt = this.format === 'protobuf' ? 'PB' : 'JSON';
                console.log(`[BBox ${fmt}] frame#${frameNum} (${this.stats.eventsReceived} events, ${(this.stats.bytesReceived / 1024).toFixed(1)} KB)`);
            }

            // Update current detections (no smoothing)
            this._updateDetections(newDetections);

            if (this.onStatsUpdate) {
                this.onStatsUpdate(this.stats);
            }
        } catch (error) {
            console.error('[BBox] Error parsing detection data:', error, data.substring(0, 100));
        }
    }

    _handleStatusData(data) {
        try {
            let parsed;
            if (this.format === 'protobuf') {
                const bytes = base64ToBytes(data);
                parsed = decodeStatusEvent(bytes);
            } else {
                parsed = JSON.parse(data);
            }

            // Extract frame info from status event
            // Status format: { shared_memory: {...}, latest_detection: {...}, monitor: {...}, timestamp: ... }
            if (parsed.shared_memory) {
                // Use total_frames_written as frame counter (updates regardless of detection)
                let frameNumber = parsed.shared_memory.total_frames_written || 0;
                let timestamp = parsed.timestamp || 0;

                // If we have latest_detection, only use its frame_number if recent
                if (parsed.latest_detection) {
                    const detectionFrame = parsed.latest_detection.frame_number || 0;
                    // Only use detection frame if it's within 30 frames of camera frame
                    // (prevents stale detection data from overwriting current frame number)
                    if (detectionFrame > 0 && (frameNumber - detectionFrame) < 30) {
                        frameNumber = detectionFrame;
                    }
                    timestamp = parsed.latest_detection.timestamp || timestamp;
                }

                // Update base values for interpolation
                this.frameInfo.baseFrameNumber = frameNumber;
                this.frameInfo.baseTime = performance.now();
                this.frameInfo.frameNumber = frameNumber;
                this.frameInfo.timestamp = timestamp;
                this.frameInfo.lastUpdateTime = performance.now();

                // Get FPS from monitor stats if available
                if (parsed.monitor && parsed.monitor.current_fps > 0) {
                    this.frameInfo.estimatedFps = parsed.monitor.current_fps;
                }
            }
        } catch (error) {
            console.error('[BBox] Error parsing status data:', error, data.substring(0, 100));
        }
    }

    /**
     * Update current detections (no smoothing - direct replacement)
     */
    _updateDetections(newDetections) {
        this.currentDetections = newDetections;
    }

    _renderLoop() {
        if (!this.isRunning) return;

        const now = performance.now();

        // Time-based stale detection cleanup
        if (this.stats.lastEventTime > 0 &&
            now - this.stats.lastEventTime > this.STALE_THRESHOLD_MS) {
            this._cleanupStaleDetections();
        }

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw current bboxes (no smoothing)
        for (const detection of this.currentDetections) {
            this._drawBBox(detection);
        }

        // Draw stats using frame info from status SSE (updates independently of detections)
        this._drawStats();

        // Update FPS stats
        this.stats.framesRendered++;
        if (now - this.stats.lastUpdateTime >= 1000) {
            this.stats.renderFps = this.stats.framesRendered;
            this.stats.framesRendered = 0;
            this.stats.lastUpdateTime = now;
        }

        this.animationId = requestAnimationFrame(() => this._renderLoop());
    }

    /**
     * Clean up stale detections when no detection events arrive
     * Called from render loop when detection events are stale
     */
    _cleanupStaleDetections() {
        if (this.currentDetections.length === 0) return;

        // Clear all detections when stale
        this.currentDetections = [];

        // Reset lastEventTime to prevent continuous cleanup
        this.stats.lastEventTime = performance.now();
    }

    _drawStats() {
        // Interpolate frame number and timestamp between SSE updates for smooth display
        let frameNum = this.frameInfo.baseFrameNumber || 0;
        let timestamp = this.frameInfo.timestamp || 0;

        if (this.frameInfo.baseTime > 0 && this.frameInfo.estimatedFps > 0) {
            const elapsedMs = performance.now() - this.frameInfo.baseTime;
            const estimatedFrames = Math.floor(elapsedMs / 1000 * this.frameInfo.estimatedFps);
            frameNum = this.frameInfo.baseFrameNumber + estimatedFrames;
            // Also interpolate timestamp (add elapsed seconds)
            if (timestamp > 0) {
                timestamp = this.frameInfo.timestamp + elapsedMs / 1000;
            }
        }

        let timeStr = '--';
        if (timestamp > 0) {
            const date = new Date(timestamp * 1000);
            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const dd = String(date.getDate()).padStart(2, '0');
            const HH = String(date.getHours()).padStart(2, '0');
            const MM = String(date.getMinutes()).padStart(2, '0');
            const ss = String(date.getSeconds()).padStart(2, '0');
            timeStr = `${yyyy}/${mm}/${dd} ${HH}:${MM}:${ss}`;
        }

        const frameDigits = String(frameNum).length;
        const minDigits = Math.max(6, Math.ceil(frameDigits / 2) * 2);
        const frameStr = String(frameNum).padStart(minDigits, ' ');
        const text = `Frame: ${frameStr}  Time: ${timeStr}`;

        this.ctx.font = '16px monospace';
        const charWidth = 9.6;
        const totalChars = 34 + minDigits;
        const bgWidth = totalChars * charWidth + 20;

        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.fillRect(10, 10, bgWidth, 24);
        this.ctx.fillStyle = '#FFFF00';
        this.ctx.fillText(text, 15, 27);
    }

    _drawBBox(detection) {
        const { bbox, class_name, confidence } = detection;
        const color = COLORS[class_name] || '#FFFFFF';

        const scaleX = this.canvas.width / 640;
        const scaleY = this.canvas.height / 480;

        const x = bbox.x * scaleX;
        const y = bbox.y * scaleY;
        const w = bbox.w * scaleX;
        const h = bbox.h * scaleY;

        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(x, y, w, h);

        const label = `${class_name}: ${(confidence * 100).toFixed(0)}%`;
        this.ctx.font = '14px Arial';
        const metrics = this.ctx.measureText(label);
        const labelHeight = 18;
        const labelWidth = metrics.width + 8;
        const labelY = Math.max(y - labelHeight, 0);

        this.ctx.fillStyle = color;
        this.ctx.fillRect(x, labelY, labelWidth, labelHeight);
        this.ctx.fillStyle = '#000000';
        this.ctx.fillText(label, x + 4, labelY + 13);
    }

    getStats() {
        return {
            ...this.stats,
            detectionCount: this.currentDetections.length
        };
    }
}
