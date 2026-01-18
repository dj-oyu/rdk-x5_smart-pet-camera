/**
 * BBox Overlay Renderer
 *
 * ビデオ上にバウンディングボックスをオーバーレイ描画
 * Server-Sent Eventsで検出結果をリアルタイム受信
 */

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
     * @param {string} sseUrl - Server-Sent Events URL for detections
     * @param {Object} options - Configuration options
     */
    constructor(videoElement, canvasElement, sseUrl = '/api/detections/stream', options = {}) {
        this.video = videoElement;
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d');
        this.sseUrl = sseUrl;

        // Format configuration
        this.useProtobuf = options.useProtobuf || false;
        this.onFormatChange = options.onFormatChange || null;

        // Detection state
        this.detections = [];
        this.latestDetection = null;
        this.lastDetectionTime = 0; // Timestamp of last valid detection update
        this.eventSource = null;

        // Animation control
        this.animationId = null;
        this.isRunning = false;

        // Persistence settings
        this.PERSISTENCE_MS = 2000; // Keep bbox for 2000ms (SSE sends every ~1s)

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

    /**
     * Setup canvas to match video size
     */
    _setupCanvas() {
        const updateCanvasSize = () => {
            if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
                this.canvas.width = this.video.videoWidth;
                this.canvas.height = this.video.videoHeight;
                console.log(`[BBox] Canvas sized to ${this.canvas.width}x${this.canvas.height}`);
            }
        };

        // Update on video metadata load
        this.video.addEventListener('loadedmetadata', updateCanvasSize);

        // Also try to update immediately
        updateCanvasSize();
    }

    /**
     * Start receiving detections and rendering
     */
    start() {
        if (this.isRunning) {
            console.warn('[BBox] Already running');
            return;
        }

        console.log('[BBox] Starting overlay renderer...');

        // Start SSE connection
        this._connectSSE();

        // Start render loop
        this.isRunning = true;
        this._renderLoop();

        console.log('[BBox] Overlay renderer started');
    }

    /**
     * Stop rendering and close SSE connection
     */
    stop() {
        console.log('[BBox] Stopping overlay renderer...');

        this.isRunning = false;

        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        console.log('[BBox] Overlay renderer stopped');
    }

    /**
     * Switch detection format (JSON/Protobuf)
     * @param {boolean} useProtobuf - Use Protobuf format
     */
    setFormat(useProtobuf) {
        if (this.useProtobuf === useProtobuf) return;

        console.log(`[BBox] Switching format to: ${useProtobuf ? 'Protobuf' : 'JSON'}`);
        this.useProtobuf = useProtobuf;

        // Reconnect with new format
        if (this.isRunning) {
            if (this.eventSource) {
                this.eventSource.close();
                this.eventSource = null;
            }
            this._connectSSE();
        }
    }

    /**
     * Connect to detection SSE stream
     * Uses EventSource for JSON (standard), fetch for Protobuf (custom header)
     */
    _connectSSE() {
        console.log(`[BBox] Connecting to SSE: ${this.sseUrl} (format: ${this.useProtobuf ? 'Protobuf' : 'JSON'})`);

        // EventSource doesn't support custom headers, so use JSON only
        // For Protobuf support, would need to use fetch + ReadableStream
        this.eventSource = new EventSource(this.sseUrl);

        this.eventSource.onmessage = (event) => {
            try {
                // Track bandwidth
                this.stats.eventsReceived++;
                this.stats.bytesReceived += event.data.length;
                this.stats.lastEventTime = performance.now();

                const data = JSON.parse(event.data);

                // Update detections
                // Support both formats: direct detections array and wrapped in latest_detection
                let newDetections = [];
                if (data.detections) {
                    newDetections = data.detections;
                    this.latestDetection = data;
                } else if (data.latest_detection && data.latest_detection.detections) {
                    newDetections = data.latest_detection.detections;
                    this.latestDetection = data.latest_detection;
                }

                // Log frame number every 30 frames to check order
                const frameNum = data.frame_number || (data.latest_detection && data.latest_detection.frame_number) || 0;
                if (frameNum % 30 === 0) {
                    console.log(`[BBox SSE] Received frame#${frameNum} (${this.stats.eventsReceived} events, ${(this.stats.bytesReceived / 1024).toFixed(1)} KB)`);
                }

                // Only update if we have detections or if we received an empty list (to clear eventually)
                // If newDetections is not empty, update immediately and reset timer
                if (newDetections && newDetections.length > 0) {
                    this.detections = newDetections;
                    this.lastDetectionTime = performance.now();
                } else if (data.frame_number) {
                    // Update stats even if no detections
                    this.latestDetection = data;
                }

                // Notify format change callback with stats
                if (this.onFormatChange) {
                    this.onFormatChange(this.stats);
                }

            } catch (error) {
                console.error('[BBox] Error parsing SSE data:', error);
            }
        };

        this.eventSource.onerror = (error) => {
            console.error('[BBox] SSE error:', error);
            // Will auto-reconnect
        };

        this.eventSource.onopen = () => {
            console.log('[BBox] SSE connected');
            this.stats.bytesReceived = 0;
            this.stats.eventsReceived = 0;
        };
    }

    /**
     * Render loop (requestAnimationFrame)
     */
    _renderLoop() {
        if (!this.isRunning) return;

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Check persistence
        const now = performance.now();
        const showDetections = (now - this.lastDetectionTime) < this.PERSISTENCE_MS;

        // Draw bounding boxes if within persistence window
        if (showDetections) {
            this.detections.forEach(detection => {
                this._drawBBox(detection);
            });
        }

        // Draw stats (always draw latest available stats)
        if (this.latestDetection) {
            this._drawStats(this.latestDetection);
        }

        // Update stats
        this.stats.framesRendered++;
        if (now - this.stats.lastUpdateTime >= 1000) {
            this.stats.renderFps = this.stats.framesRendered;
            this.stats.framesRendered = 0;
            this.stats.lastUpdateTime = now;
        }

        // Schedule next frame
        this.animationId = requestAnimationFrame(() => this._renderLoop());
    }

    /**
     * Draw frame stats (Frame number, timestamp)
     * @param {Object} detectionData - Detection object with metadata
     */
    _drawStats(detectionData) {
        const frameNum = detectionData.frame_number || 0;
        const timestamp = detectionData.timestamp || 0;

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

        // Fixed-width frame number per digit group (prevents jitter)
        // Determine minimum width based on current digits
        const frameDigits = String(frameNum).length;
        const minDigits = Math.max(6, Math.ceil(frameDigits / 2) * 2); // Round up to even number, min 6
        const frameStr = String(frameNum).padStart(minDigits, ' ');
        const text = `Frame: ${frameStr}  Time: ${timeStr}`;

        this.ctx.font = '16px monospace';

        // Calculate fixed background width based on digit count
        // Each digit ≈ 9.6px in 16px monospace, plus margins
        // "Frame: " = 7 chars, "  Time: " = 8 chars, timestamp = 19 chars
        // Total base = 34 chars + minDigits
        const charWidth = 9.6; // 16px monospace character width
        const totalChars = 34 + minDigits;
        const bgWidth = totalChars * charWidth + 20; // Add padding

        // Draw background (stable width per digit group)
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.fillRect(10, 10, bgWidth, 24);

        // Draw text
        this.ctx.fillStyle = '#FFFF00'; // Yellow
        this.ctx.fillText(text, 15, 27);
    }

    /**
     * Draw a single bounding box
     * @param {Object} detection - Detection object with bbox, class_name, confidence
     */
    _drawBBox(detection) {
        const { bbox, class_name, confidence } = detection;
        const color = COLORS[class_name] || '#FFFFFF';

        // Scale bbox to canvas size
        const scaleX = this.canvas.width / 640;  // Assume 640x480 detection resolution
        const scaleY = this.canvas.height / 480;

        const x = bbox.x * scaleX;
        const y = bbox.y * scaleY;
        const w = bbox.w * scaleX;
        const h = bbox.h * scaleY;

        // Draw rectangle
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(x, y, w, h);

        // Draw label background
        const label = `${class_name}: ${(confidence * 100).toFixed(0)}%`;
        this.ctx.font = '14px Arial';
        const metrics = this.ctx.measureText(label);
        const labelHeight = 18;
        const labelWidth = metrics.width + 8;
        const labelY = Math.max(y - labelHeight, 0);

        this.ctx.fillStyle = color;
        this.ctx.fillRect(x, labelY, labelWidth, labelHeight);

        // Draw label text
        this.ctx.fillStyle = '#000000';
        this.ctx.fillText(label, x + 4, labelY + 13);
    }

    /**
     * Get render statistics
     * @returns {Object}
     */
    getStats() {
        return {
            ...this.stats,
            detectionCount: this.detections.length
        };
    }
}