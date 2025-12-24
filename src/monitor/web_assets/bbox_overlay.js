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
     */
    constructor(videoElement, canvasElement, sseUrl = '/api/detections/stream') {
        this.video = videoElement;
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d');
        this.sseUrl = sseUrl;

        // Detection state
        this.detections = [];
        this.latestDetection = null;
        this.eventSource = null;

        // Animation control
        this.animationId = null;
        this.isRunning = false;

        // Stats
        this.stats = {
            framesRendered: 0,
            lastUpdateTime: 0,
            renderFps: 0
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
     * Connect to detection SSE stream
     */
    _connectSSE() {
        console.log(`[BBox] Connecting to SSE: ${this.sseUrl}`);

        this.eventSource = new EventSource(this.sseUrl);

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Update detections
                if (data.latest_detection && data.latest_detection.detections) {
                    this.detections = data.latest_detection.detections;
                    this.latestDetection = data.latest_detection;
                } else {
                    this.detections = [];
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
        };
    }

    /**
     * Render loop (requestAnimationFrame)
     */
    _renderLoop() {
        if (!this.isRunning) return;

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw bounding boxes
        this.detections.forEach(detection => {
            this._drawBBox(detection);
        });

        // Update stats
        this.stats.framesRendered++;
        const now = performance.now();
        if (now - this.stats.lastUpdateTime >= 1000) {
            this.stats.renderFps = this.stats.framesRendered;
            this.stats.framesRendered = 0;
            this.stats.lastUpdateTime = now;
        }

        // Schedule next frame
        this.animationId = requestAnimationFrame(() => this._renderLoop());
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
