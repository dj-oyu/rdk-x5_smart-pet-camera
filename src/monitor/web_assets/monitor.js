window.addEventListener('DOMContentLoaded', () => {
    const fpsEl = document.getElementById('fps');
    const detectionsEl = document.getElementById('detections');
    const streamEl = document.getElementById('stream');
    const shmBufferEl = document.getElementById('shm-buffer');
    const framesTotalEl = document.getElementById('frames-total');
    const detectionVersionEl = document.getElementById('detection-version');
    const historyListEl = document.getElementById('history-list');
    const rankingListEl = document.getElementById('ranking-list');
    const timelineListEl = document.getElementById('timeline-list');
    const timelineChartEl = document.getElementById('timeline-chart');
    const timelineCanvas = document.getElementById('timeline-canvas');
    const trajectoryCardEl = document.getElementById('trajectory-card');
    const trajectoryCanvas = document.getElementById('trajectory-canvas');
    const trajectoryLegendEl = document.getElementById('trajectory-legend');
    const timelineLegendEl = document.getElementById('timeline-legend');
    const viewToggle = document.getElementById('view-toggle');
    const statusBadge = document.getElementById('status-badge');
    const lastUpdatedEl = document.getElementById('last-updated');
    const targetFpsEl = document.getElementById('target-fps');

    let activeView = 'history';
    let lastHistory = [];
    let trajectoryPoints = [];
    let lastTrajectoryKey = null;

    const trajectoryColors = {
        cat: [110, 255, 160],
        dog: [255, 200, 120],
        bird: [160, 220, 255],
        food_bowl: [120, 200, 255],
        water_bowl: [255, 140, 140],
        dish: [150, 180, 255],
        person: [255, 240, 140],
        book: [200, 160, 255],
        cell_phone: [255, 160, 240],
        chair: [120, 190, 255],
        couch: [190, 150, 255],
        tv: [140, 255, 200],
        laptop: [160, 210, 255],
        remote: [255, 210, 150],
        bottle: [120, 255, 210],
        cup: [255, 190, 210],
    };

    function formatNumber(value) {
        return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
    }

    function formatTimestamp(ts) {
        if (!ts) return '--';
        const date = new Date(ts * 1000);
        if (Number.isNaN(date.getTime())) return '--';
        return date.toLocaleString();
    }

    function bucketCount(count) {
        if (count <= 1) return '1';
        if (count <= 3) return '2-3';
        if (count <= 5) return '4-5';
        if (count <= 10) return '6-10';
        return '11+';
    }

    function summarizeDetections(detections) {
        if (!detections || detections.length === 0) {
            return '<span class="tag tag-accent">no detections</span>';
        }
        const counts = {};
        detections.forEach((det) => {
            counts[det.class_name] = (counts[det.class_name] || 0) + 1;
        });
        return Object.entries(counts)
            .map(([name, count]) => {
                return `<span class="tag ${name}">${name} x${count}</span>`;
            })
            .join('');
    }

    function renderLegend(container, classCounts, options = {}) {
        if (!container) return;
        container.innerHTML = '';

        if (!classCounts || classCounts.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'legend-empty';
            empty.textContent = 'データなし';
            container.appendChild(empty);
            return;
        }

        if (options.fillLabel) {
            const fillItem = document.createElement('span');
            fillItem.className = 'legend-item';
            const swatch = document.createElement('span');
            swatch.className = 'legend-swatch fill';
            const label = document.createElement('span');
            label.textContent = options.fillLabel;
            fillItem.appendChild(swatch);
            fillItem.appendChild(label);
            container.appendChild(fillItem);
        }

        classCounts.forEach(([name]) => {
            const item = document.createElement('span');
            item.className = 'legend-item';
            const swatch = document.createElement('span');
            swatch.className = 'legend-swatch';
            const color = trajectoryColors[name] || [110, 231, 255];
            swatch.style.background = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.9)`;
            const label = document.createElement('span');
            label.textContent = name;
            item.appendChild(swatch);
            item.appendChild(label);
            container.appendChild(item);
        });

        if (options.moreCount && options.moreCount > 0) {
            const moreItem = document.createElement('span');
            moreItem.className = 'legend-item';
            moreItem.textContent = `+${options.moreCount} more`;
            container.appendChild(moreItem);
        }
    }

    function updateLegends(history, points) {
        const historyCounts = {};
        (history || []).forEach((entry) => {
            entry.detections.forEach((det) => {
                historyCounts[det.class_name] = (historyCounts[det.class_name] || 0) + 1;
            });
        });
        const historyEntries = Object.entries(historyCounts).sort((a, b) => b[1] - a[1]);
        const historyTop = historyEntries.slice(0, 5);
        renderLegend(timelineLegendEl, historyTop, {
            fillLabel: '検出量',
            moreCount: Math.max(historyEntries.length - historyTop.length, 0),
        });

        const trajectoryCounts = {};
        (points || []).forEach((point) => {
            if (!point.className) return;
            trajectoryCounts[point.className] =
                (trajectoryCounts[point.className] || 0) + 1;
        });
        const trajectoryEntries = Object.entries(trajectoryCounts).sort((a, b) => b[1] - a[1]);
        const trajectoryTop = trajectoryEntries.slice(0, 5);
        renderLegend(trajectoryLegendEl, trajectoryTop, {
            moreCount: Math.max(trajectoryEntries.length - trajectoryTop.length, 0),
        });
    }

    function renderHistory(history) {
        if (!history || history.length === 0) {
            historyListEl.innerHTML =
                '<p class="muted">まだ検出結果はありません。カメラ入力を待機しています。</p>';
            return;
        }

        historyListEl.innerHTML = history
            .map((entry, index) => {
                const timeLabel = formatTimestamp(entry.timestamp);
                const header = `${bucketCount(entry.num_detections)} detections / Frame #${entry.frame_number}`;
                const meta = `v${entry.version} ・ ${timeLabel}`;
                return `
                    <div class="history-card">
                        <div class="history-title">${header}</div>
                        <div class="history-meta">
                            <span>${index === 0 ? 'latest' : 'history'}</span>
                            <span>${meta}</span>
                        </div>
                        <div class="history-tags">
                            ${summarizeDetections(entry.detections)}
                        </div>
                    </div>
                `;
            })
            .join('');
    }

    function renderRanking(history) {
        if (!history || history.length === 0) {
            rankingListEl.innerHTML =
                '<p class="muted">まだ検出結果はありません。カメラ入力を待機しています。</p>';
            return;
        }

        const counts = {};
        history.forEach((entry) => {
            entry.detections.forEach((det) => {
                counts[det.class_name] = (counts[det.class_name] || 0) + 1;
            });
        });

        const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (ranked.length === 0) {
            rankingListEl.innerHTML =
                '<p class="muted">まだ検出結果はありません。カメラ入力を待機しています。</p>';
            return;
        }

        rankingListEl.innerHTML = ranked
            .map(([name, count], index) => {
                const badge = index === 0 ? '👑' : `#${index + 1}`;
                return `
                    <div class="rank-item">
                        <div class="rank-name">${badge} ${name}</div>
                        <div class="rank-value">${bucketCount(count)} hits</div>
                    </div>
                `;
            })
            .join('');
    }

    function renderTimeline(history) {
        if (!history || history.length === 0) {
            timelineListEl.innerHTML =
                '<p class="muted">まだ検出結果はありません。カメラ入力を待機しています。</p>';
            return;
        }

        const maxDetections = Math.max(...history.map((entry) => entry.num_detections), 1);
        timelineListEl.innerHTML = history
            .map((entry) => {
                const timeLabel = formatTimestamp(entry.timestamp);
                const barWidth = Math.max(
                    6,
                    Math.round((entry.num_detections / maxDetections) * 100)
                );
                const classCounts = {};
                entry.detections.forEach((det) => {
                    classCounts[det.class_name] = (classCounts[det.class_name] || 0) + 1;
                });
                const dominant = Object.entries(classCounts).sort((a, b) => b[1] - a[1])[0];
                const color = dominant
                    ? trajectoryColors[dominant[0]] || [110, 231, 255]
                    : [110, 231, 255];
                return `
                    <div class="timeline-row">
                        <div class="timeline-time">${timeLabel}</div>
                        <div class="timeline-bar" style="width:${barWidth}%; background: linear-gradient(90deg, rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.25), rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.9));"></div>
                        <div class="timeline-count">${bucketCount(entry.num_detections)}</div>
                    </div>
                `;
            })
            .join('');
    }

    function drawTimelineChart(history) {
        if (!timelineCanvas) return;
        const ctx = timelineCanvas.getContext('2d');
        if (!ctx) return;

        const width = timelineCanvas.clientWidth || 320;
        const height = timelineCanvas.clientHeight || 140;
        timelineCanvas.width = width * window.devicePixelRatio;
        timelineCanvas.height = height * window.devicePixelRatio;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        ctx.clearRect(0, 0, width, height);

        if (!history || history.length === 0) {
            ctx.fillStyle = 'rgba(154, 174, 211, 0.6)';
            ctx.font = '12px "Space Grotesk", sans-serif';
            ctx.fillText('no data', 10, height / 2);
            return;
        }

        const values = history.map((entry) => entry.num_detections).reverse();
        const classes = history
            .map((entry) => {
                const classCounts = {};
                entry.detections.forEach((det) => {
                    classCounts[det.class_name] = (classCounts[det.class_name] || 0) + 1;
                });
                const dominant = Object.entries(classCounts).sort((a, b) => b[1] - a[1])[0];
                return dominant ? dominant[0] : null;
            })
            .reverse();
        const maxValue = Math.max(...values, 1);
        const minValue = 0;
        const padding = 12;
        const chartWidth = width - padding * 2;
        const chartHeight = height - padding * 2;

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = padding + (chartHeight / 4) * i;
            ctx.beginPath();
            ctx.moveTo(padding, y);
            ctx.lineTo(width - padding, y);
            ctx.stroke();
        }

        values.forEach((value, index) => {
            const x = padding + (chartWidth / Math.max(values.length - 1, 1)) * index;
            const y =
                padding +
                chartHeight -
                ((value - minValue) / (maxValue - minValue || 1)) * chartHeight;
            if (index === 0) {
                ctx.beginPath();
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
                const className = classes[index];
                const color = trajectoryColors[className] || [110, 231, 255];
                ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.9)`;
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(x, y);
            }
        });

        ctx.beginPath();
        values.forEach((value, index) => {
            const x = padding + (chartWidth / Math.max(values.length - 1, 1)) * index;
            const y =
                padding +
                chartHeight -
                ((value - minValue) / (maxValue - minValue || 1)) * chartHeight;
            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.lineTo(width - padding, height - padding);
        ctx.lineTo(padding, height - padding);
        ctx.closePath();
        ctx.fillStyle = 'rgba(110, 231, 255, 0.18)';
        ctx.fill();
    }

    function drawTrajectory(points) {
        if (!trajectoryCanvas) return;
        const ctx = trajectoryCanvas.getContext('2d');
        if (!ctx) return;

        const width = trajectoryCanvas.clientWidth || 320;
        const height = trajectoryCanvas.clientHeight || 180;
        trajectoryCanvas.width = width * window.devicePixelRatio;
        trajectoryCanvas.height = height * window.devicePixelRatio;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        ctx.clearRect(0, 0, width, height);

        if (!points || points.length === 0) {
            ctx.fillStyle = 'rgba(154, 174, 211, 0.6)';
            ctx.font = '12px "Space Grotesk", sans-serif';
            ctx.fillText('no trajectory data', 10, height / 2);
            return;
        }

        let frameWidth = streamEl?.naturalWidth || 0;
        let frameHeight = streamEl?.naturalHeight || 0;

        if (!frameWidth || !frameHeight) {
            let maxX = 0;
            let maxY = 0;
            points.forEach((point) => {
                maxX = Math.max(maxX, point.rawX || 0);
                maxY = Math.max(maxY, point.rawY || 0);
            });
            frameWidth = maxX || 1;
            frameHeight = maxY || 1;
        }

        const scaledPoints = points.map((point) => {
            return {
                x: (point.x / frameWidth) * width,
                y: (point.y / frameHeight) * height,
                color: point.color || trajectoryColors[point.className] || [110, 231, 255],
            };
        });

        for (let i = 1; i < scaledPoints.length; i++) {
            const alpha = i / scaledPoints.length;
            const [r, g, b] = scaledPoints[i].color;
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(scaledPoints[i - 1].x, scaledPoints[i - 1].y);
            ctx.lineTo(scaledPoints[i].x, scaledPoints[i].y);
            ctx.stroke();
        }

        scaledPoints.forEach((point, index) => {
            const alpha = (index + 1) / scaledPoints.length;
            const [r, g, b] = point.color;
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
            ctx.beginPath();
            ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    function updateTrajectory(latestDetection) {
        if (!latestDetection || !latestDetection.detections || latestDetection.detections.length === 0) {
            return;
        }

        const key = `${latestDetection.frame_number}:${latestDetection.version}`;
        if (key === lastTrajectoryKey) {
            return;
        }
        lastTrajectoryKey = key;

        let best = latestDetection.detections[0];
        latestDetection.detections.forEach((det) => {
            if (det.confidence > best.confidence) best = det;
        });
        const centerX = best.bbox.x + best.bbox.w / 2;
        const centerY = best.bbox.y + best.bbox.h / 2;

        trajectoryPoints.push({
            x: centerX,
            y: centerY,
            rawX: best.bbox.x + best.bbox.w,
            rawY: best.bbox.y + best.bbox.h,
            className: best.class_name,
            color: trajectoryColors[best.class_name] || [110, 231, 255],
        });
        if (trajectoryPoints.length > 24) {
            trajectoryPoints = trajectoryPoints.slice(-24);
        }
    }

    function applyView(view) {
        activeView = view;
        historyListEl.style.display = view === 'history' ? 'flex' : 'none';
        rankingListEl.style.display = view === 'ranking' ? 'flex' : 'none';
        timelineListEl.style.display = view === 'timeline' ? 'flex' : 'none';
        timelineChartEl.style.display = view === 'timeline' ? 'block' : 'none';
        viewToggle.querySelectorAll('button').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
    }

    viewToggle.addEventListener('click', (event) => {
        const target = event.target.closest('button[data-view]');
        if (!target) return;
        applyView(target.dataset.view);
    });

    function updateStatus(data) {
        fpsEl.textContent = `${formatNumber(data.monitor.current_fps)} fps`;
        detectionsEl.textContent = formatNumber(data.monitor.detection_count);
        targetFpsEl.textContent = `目標: ${data.monitor.target_fps} fps`;

        framesTotalEl.textContent = `buffer: ${data.shared_memory.frame_count} / total: ${formatNumber(
            data.shared_memory.total_frames_written
        )}`;
        detectionVersionEl.textContent = `version: ${data.shared_memory.detection_version}`;
        shmBufferEl.textContent = data.shared_memory.has_detection
            ? '🟢 receiving detections'
            : '🟡 waiting for detections';
        statusBadge.textContent = data.shared_memory.has_detection
            ? 'Receiving detections'
            : 'Live stream active';

        const updatedAt = new Date(data.timestamp * 1000);
        lastUpdatedEl.textContent = updatedAt.toLocaleTimeString();

        const filteredHistory = (data.detection_history || []).filter(
            (entry) => entry.num_detections > 0
        );
        lastHistory = filteredHistory;
        renderHistory(filteredHistory);
        renderRanking(filteredHistory);
        renderTimeline(filteredHistory);
        updateTrajectory(data.latest_detection);
        drawTrajectory(trajectoryPoints);
        updateLegends(filteredHistory, trajectoryPoints);
        if (activeView === 'timeline') {
            drawTimelineChart(filteredHistory);
        }
    }

    async function fetchStatus() {
        try {
            const res = await fetch('/api/status');
            if (!res.ok) return;
            const data = await res.json();
            updateStatus(data);
        } catch (error) {
            statusBadge.textContent = 'Waiting for data...';
        }
    }

    function startStatusStream() {
        const stream = new EventSource('/api/status/stream');
        stream.addEventListener('message', (event) => {
            if (!event.data) return;
            try {
                const data = JSON.parse(event.data);
                updateStatus(data);
            } catch (error) {
                statusBadge.textContent = 'Waiting for data...';
            }
        });
        stream.addEventListener('error', () => {
            stream.close();
            fetchStatus();
            setInterval(fetchStatus, 1500);
        });
    }

    // Performance metrics tracking
    let performanceStats = {
        eventsReceived: 0,
        bytesReceived: 0,
        startTime: Date.now(),
        eventRate: 0,
        bandwidth: 0
    };

    function updatePerformanceMetrics(stats) {
        if (!stats) return;

        performanceStats.eventsReceived = stats.eventsReceived;
        performanceStats.bytesReceived = stats.bytesReceived;

        const elapsed = (Date.now() - performanceStats.startTime) / 1000; // seconds
        if (elapsed > 0) {
            performanceStats.eventRate = (stats.eventsReceived / elapsed).toFixed(1);
            performanceStats.bandwidth = (stats.bytesReceived / elapsed / 1024).toFixed(2); // KB/s
        }

        // Update UI if elements exist
        const eventRateEl = document.getElementById('event-rate');
        const bandwidthEl = document.getElementById('bandwidth');
        const reductionEl = document.getElementById('bandwidth-reduction');

        if (eventRateEl) {
            eventRateEl.textContent = `${performanceStats.eventRate} events/sec`;
        }
        if (bandwidthEl) {
            bandwidthEl.textContent = `${performanceStats.bandwidth} KB/s`;
        }
        if (reductionEl) {
            // Calculate reduction vs polling (30 events/sec baseline)
            const pollingRate = 30; // events/sec
            const reduction = ((1 - performanceStats.eventRate / pollingRate) * 100).toFixed(0);
            reductionEl.textContent = `~${reduction}% reduction`;
            reductionEl.className = `stat-badge ${reduction > 50 ? 'success' : 'info'}`;
        }
    }

    // Recording functionality using MediaRecorder API
    const RecordingManager = {
        mediaRecorder: null,
        recordedChunks: [],
        isRecording: false,
        startTime: null,
        timerInterval: null,

        // Find the best supported MIME type
        getSupportedMimeType() {
            const mimeTypes = [
                'video/webm;codecs=h264',
                'video/mp4;codecs=avc1',
                'video/webm;codecs=vp9',
                'video/webm;codecs=vp8',
                'video/webm'
            ];
            for (const mimeType of mimeTypes) {
                if (MediaRecorder.isTypeSupported(mimeType)) {
                    console.log('[Recording] Using MIME type:', mimeType);
                    return mimeType;
                }
            }
            console.warn('[Recording] No supported MIME type found');
            return null;
        },

        // Get file extension based on MIME type
        getFileExtension(mimeType) {
            if (mimeType.includes('mp4')) return 'mp4';
            return 'webm';
        },

        // Update UI elements
        updateUI() {
            const recordBtn = document.getElementById('record-btn');
            const recordStatus = document.getElementById('record-status');

            if (this.isRecording) {
                recordBtn?.classList.add('recording');
                if (recordStatus) {
                    recordStatus.classList.add('recording');
                    this.updateTimer();
                }
            } else {
                recordBtn?.classList.remove('recording');
                if (recordStatus) {
                    recordStatus.classList.remove('recording');
                    recordStatus.textContent = '';
                }
            }
        },

        // Update recording timer display
        updateTimer() {
            const recordStatus = document.getElementById('record-status');
            if (!recordStatus || !this.startTime) return;

            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            recordStatus.textContent = `REC ${minutes}:${seconds}`;
        },

        // Start recording
        start() {
            const video = document.getElementById('webrtc-video');
            if (!video || !video.srcObject) {
                alert('WebRTCストリームが接続されていません。\nWebRTCモードで接続してから録画してください。');
                return false;
            }

            const mimeType = this.getSupportedMimeType();
            if (!mimeType) {
                alert('このブラウザは録画機能に対応していません。');
                return false;
            }

            try {
                // Use the video's MediaStream directly
                const stream = video.srcObject;

                this.mediaRecorder = new MediaRecorder(stream, {
                    mimeType: mimeType,
                    videoBitsPerSecond: 2000000
                });

                this.recordedChunks = [];

                this.mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        this.recordedChunks.push(event.data);
                    }
                };

                this.mediaRecorder.onstop = () => {
                    this.download(mimeType);
                };

                this.mediaRecorder.onerror = (event) => {
                    console.error('[Recording] Error:', event.error);
                    alert('録画中にエラーが発生しました。');
                    this.isRecording = false;
                    this.updateUI();
                };

                // Start recording (collect data every second)
                this.mediaRecorder.start(1000);
                this.isRecording = true;
                this.startTime = Date.now();

                // Start timer update
                this.timerInterval = setInterval(() => this.updateTimer(), 1000);

                this.updateUI();
                console.log('[Recording] Started');
                return true;

            } catch (error) {
                console.error('[Recording] Failed to start:', error);
                alert('録画の開始に失敗しました: ' + error.message);
                return false;
            }
        },

        // Stop recording
        stop() {
            if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
                return;
            }

            try {
                this.mediaRecorder.stop();
                this.isRecording = false;

                if (this.timerInterval) {
                    clearInterval(this.timerInterval);
                    this.timerInterval = null;
                }

                this.updateUI();
                console.log('[Recording] Stopped');

            } catch (error) {
                console.error('[Recording] Failed to stop:', error);
            }
        },

        // Download recorded video
        download(mimeType) {
            if (this.recordedChunks.length === 0) {
                console.warn('[Recording] No data to download');
                return;
            }

            const blob = new Blob(this.recordedChunks, { type: mimeType });
            const url = URL.createObjectURL(blob);
            const extension = this.getFileExtension(mimeType);

            // Generate filename with timestamp
            const now = new Date();
            const timestamp = now.getFullYear() +
                String(now.getMonth() + 1).padStart(2, '0') +
                String(now.getDate()).padStart(2, '0') + '_' +
                String(now.getHours()).padStart(2, '0') +
                String(now.getMinutes()).padStart(2, '0') +
                String(now.getSeconds()).padStart(2, '0');
            const filename = `pet_camera_${timestamp}.${extension}`;

            // Trigger download
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Cleanup
            setTimeout(() => URL.revokeObjectURL(url), 100);

            console.log('[Recording] Downloaded:', filename, 'Size:', (blob.size / 1024 / 1024).toFixed(2), 'MB');
        },

        // Toggle recording
        toggle() {
            if (this.isRecording) {
                this.stop();
            } else {
                this.start();
            }
        }
    };

    // Setup recording button
    const recordBtn = document.getElementById('record-btn');
    if (recordBtn) {
        recordBtn.addEventListener('click', () => RecordingManager.toggle());
    }

    // Expose for debugging
    window.RecordingManager = RecordingManager;

    startStatusStream();
    applyView('history');

    window.addEventListener('resize', () => {
        if (activeView === 'timeline') {
            drawTimelineChart(lastHistory);
        }
        drawTrajectory(trajectoryPoints);
    });

    // Expose performance metrics updater
    window.updatePerformanceMetrics = updatePerformanceMetrics;
});
