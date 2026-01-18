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

        <div class="grid">
            <div class="panel" style="grid-row: span 2;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <div>
                        <h2>Live Feed</h2>
                        <p class="panel-subtitle" id="stream-subtitle">WebRTC H.264ストリーム（30fps、低遅延）</p>
                    </div>
                    <div style="display:flex;gap:12px;align-items:center;">
                        <div class="view-toggle">
                            <button type="button" id="btn-webrtc" class="active">WebRTC</button>
                            <button type="button" id="btn-mjpeg">MJPEG</button>
                        </div>
                        <div class="tag-row">
                            <span class="tag cat">cat</span>
                            <span class="tag food_bowl">food_bowl</span>
                            <span class="tag water_bowl">water_bowl</span>
                        </div>
                    </div>
                </div>
                <div id="video-panel" style="position:relative;">
                    <!-- WebRTC View (default) -->
                    <div id="webrtc-view" style="position:relative;width:100%;display:block;">
                        <video id="webrtc-video" autoplay playsinline muted
                               style="width:100%;height:auto;display:block;background:#000;"></video>
                        <canvas id="bbox-canvas"
                                style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;"></canvas>
                        <div id="webrtc-status"
                             style="position:absolute;top:10px;right:10px;padding:4px 8px;background:rgba(0,0,0,0.7);color:#0f0;font-size:12px;border-radius:4px;">
                            ● Connecting...
                        </div>
                    </div>
                    <!-- MJPEG View (fallback) -->
                    <div id="mjpeg-view" style="display:none;">
                        <img id="stream" alt="Live stream from Smart Pet Camera" style="width:100%;height:auto;">
                    </div>
                </div>
                <div class="trajectory-card" id="trajectory-card">
                    <div class="trajectory-title">Trajectory</div>
                    <canvas class="trajectory-canvas" id="trajectory-canvas"></canvas>
                    <div class="legend" id="trajectory-legend"></div>
                </div>
                <p class="footer-note" id="stream-footer">
                    WebRTC経由でH.264ストリームを直接配信。ブラウザ上で検出結果をリアルタイムオーバーレイ。
                </p>
            </div>

            <div class="panel">
                <h2>システムステータス</h2>
                <p class="panel-subtitle">モニター、共有メモリ、検出結果の最新サマリ</p>
                <div class="stat-grid">
                    <div class="stat">
                        <span class="stat-label">Camera FPS</span>
                        <span class="stat-value" id="fps">--</span>
                        <span class="stat-sub" id="target-fps">目標: -- fps</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Detections</span>
                        <span class="stat-value" id="detections">--</span>
                        <span class="stat-sub" id="detection-version">---</span>
                    </div>
                </div>

                <div class="list">
                    <div class="list-item">
                        <div class="list-label">Shared memory buffer</div>
                        <div class="list-value" id="shm-buffer">--</div>
                    </div>
                    <div class="list-item">
                        <div class="list-label">Latest update</div>
                        <div class="list-value" id="last-updated">--</div>
                    </div>
                    <div class="list-item">
                        <div class="list-label">Frames buffered</div>
                        <div class="list-value" id="frames-total">--</div>
                    </div>
                </div>
            </div>

            <div class="panel">
                <h2>パフォーマンス</h2>
                <p class="panel-subtitle">イベント駆動型SSEによる帯域幅削減</p>
                <div class="stat-grid">
                    <div class="stat">
                        <span class="stat-label">Event Rate</span>
                        <span class="stat-value" id="event-rate">-- events/sec</span>
                        <span class="stat-sub">vs 30/sec polling</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Bandwidth</span>
                        <span class="stat-value" id="bandwidth">-- KB/s</span>
                        <span class="stat-sub">Real-time usage</span>
                    </div>
                </div>
                <div style="margin-top:12px;text-align:center;">
                    <span class="stat-badge info" id="bandwidth-reduction">計測中...</span>
                </div>
            </div>

            <div class="panel">
                <h2>録画コントロール</h2>
                <p class="panel-subtitle">H.264ストリームの録画制御（近日公開予定）</p>
                <div style="margin-bottom:12px;">
                    <button id="record-btn" class="btn btn-primary">⏺ 録画</button>
                </div>
                <div id="record-info" class="record-info"></div>
            </div>

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
        const statusDiv = document.getElementById('webrtc-status');
        const subtitle = document.getElementById('stream-subtitle');
        const footer = document.getElementById('stream-footer');
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
                statusDiv.textContent = '● Connecting...';
                statusDiv.style.color = '#ff0';

                // Create WebRTC client (use same origin as current page)
                webrtcClient = new WebRTCVideoClient(video);

                // Connection state callback
                webrtcClient.onConnectionStateChange = (state) => {
                    console.log('[App] WebRTC state:', state);
                    if (state === 'connected') {
                        statusDiv.textContent = '● Connected (30fps)';
                        statusDiv.style.color = '#0f0';
                    } else if (state === 'connecting') {
                        statusDiv.textContent = '● Connecting...';
                        statusDiv.style.color = '#ff0';
                    } else if (state === 'failed' || state === 'closed') {
                        statusDiv.textContent = '● Disconnected';
                        statusDiv.style.color = '#f00';
                    }
                };

                // Error callback
                webrtcClient.onError = (error) => {
                    console.error('[App] WebRTC error:', error);
                    statusDiv.textContent = '● Error - Switch to MJPEG';
                    statusDiv.style.color = '#f00';
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
                statusDiv.textContent = '● Failed - Using MJPEG';
                statusDiv.style.color = '#f00';
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
            subtitle.textContent = 'MJPEG ストリーム（サーバー側BBox合成）';
            footer.textContent = '共有メモリの最新フレームにバウンディングボックスを合成したMJPEGストリームを配信しています。';
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
            subtitle.textContent = 'WebRTC H.264ストリーム（30fps、低遅延）';
            footer.textContent = 'WebRTC経由でH.264ストリームを直接配信。ブラウザ上で検出結果をリアルタイムオーバーレイ。';

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
