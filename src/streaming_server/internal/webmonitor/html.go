package webmonitor

const indexHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>Smart Pet Camera Monitor</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/assets/monitor.css">
</head>
<body>
    <div class="app">
        <div class="header">
            <div class="title">🐱 Smart Pet Camera Monitor</div>
            <span class="badge badge-secondary" id="status-badge">Waiting for data...</span>
        </div>

        <div class="main-content">
            <!-- Video Area -->
            <div class="video-container">
                <div id="video-panel">
                    <!-- WebRTC View (default) -->
                    <div id="webrtc-view" style="position:relative;width:100%;display:block;">
                        <video id="webrtc-video" autoplay playsinline muted
                               style="width:100%;height:auto;display:block;background:#000;border-radius:8px;"></video>
                        <canvas id="bbox-canvas"
                                style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;"></canvas>
                    </div>
                    <!-- MJPEG View (fallback) -->
                    <div id="mjpeg-view" style="display:none;">
                        <img id="stream" alt="Camera stream" style="width:100%;height:auto;border-radius:8px;">
                    </div>
                </div>
                <!-- Video Controls -->
                <div class="video-controls">
                    <div class="view-toggle">
                        <button type="button" id="btn-webrtc" class="active">WebRTC</button>
                        <button type="button" id="btn-mjpeg">MJPEG</button>
                    </div>
                    <div class="record-controls">
                        <button id="record-btn" class="record-btn" title="REC">
                            <span class="record-icon"></span>
                            <span class="dummy-tooltip">DUMMY</span>
                        </button>
                        <!-- TODO: 録画実装完了後に復活 <span id="record-status" class="record-status"></span> -->
                    </div>
                </div>
            </div>

            <!-- Hidden elements for JS compatibility -->
            <div style="display:none;">
                <span id="stream-subtitle"></span>
                <span id="stream-footer"></span>
                <span id="fps"></span>
                <span id="target-fps"></span>
                <span id="detections"></span>
                <span id="detection-version"></span>
                <span id="shm-buffer"></span>
                <span id="last-updated"></span>
                <span id="frames-total"></span>
                <span id="event-rate"></span>
                <span id="bandwidth"></span>
                <span id="bandwidth-reduction"></span>
                <span id="record-info"></span>
            </div>

            <!-- Trajectory visualization -->
            <div class="trajectory-card" id="trajectory-card">
                <canvas class="trajectory-canvas" id="trajectory-canvas"></canvas>
                <div class="legend" id="trajectory-legend"></div>
            </div>

            <!-- Detection Insights -->
            <div class="panel">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
                    <div>
                        <h2>検出インサイト</h2>
                        <p class="panel-subtitle">履歴・ランキング・タイムラインを切り替えて把握</p>
                    </div>
                    <div class="view-toggle" id="view-toggle">
                        <button type="button" data-view="history" class="active">履歴</button>
                        <button type="button" data-view="ranking">ランキング</button>
                        <button type="button" data-view="timeline">タイムライン</button>
                    </div>
                </div>
                <div class="detections" id="history-list">
                    <p class="muted">まだ検出結果はありません。カメラ入力を待機しています。</p>
                </div>
                <div class="rank-list" id="ranking-list" style="display:none;"></div>
                <div class="timeline" id="timeline-list" style="display:none;"></div>
                <div class="timeline-chart" id="timeline-chart" style="display:none;">
                    <canvas class="timeline-canvas" id="timeline-canvas"></canvas>
                    <div class="legend" id="timeline-legend"></div>
                </div>
            </div>
        </div>
    </div>

    <script src="/assets/monitor.js" defer></script>
    <script type="module">
        import { WebRTCVideoClient } from '/assets/webrtc_client.js';
        import { BBoxOverlay } from '/assets/bbox_overlay.js';

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
                bboxOverlay = new BBoxOverlay(video, canvas, '/api/detections/stream', {
                    useProtobuf: false,
                    onFormatChange: (stats) => {
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

            // Start MJPEG stream (set src triggers browser HTTP connection → Go Subscribe)
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

            // Stop MJPEG stream (clear src closes browser HTTP connection → Go Unsubscribe)
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
    </script>
</body>
</html>
`
