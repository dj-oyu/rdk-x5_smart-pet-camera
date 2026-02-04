/**
 * Monitor UI Module
 * Handles status display, detection history, timeline, and recording
 */

import { decodeStatusEvent, base64ToBytes } from './protobuf_decoder.js';

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
    const recordingsListEl = document.getElementById('recordings-list');

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

    // Recordings Modal
    let recordingsModalOpen = false;
    const recordingsModal = document.getElementById('recordings-modal');
    const fabRecordings = document.getElementById('fab-recordings');
    const modalClose = document.getElementById('modal-close');

    function openRecordingsModal() {
        recordingsModalOpen = true;
        recordingsModal.style.display = 'flex';
        fetchRecordings();
    }

    function closeRecordingsModal() {
        recordingsModalOpen = false;
        recordingsModal.style.display = 'none';
    }

    fabRecordings?.addEventListener('click', openRecordingsModal);
    modalClose?.addEventListener('click', closeRecordingsModal);

    // Close modal when clicking overlay background
    recordingsModal?.addEventListener('click', (event) => {
        if (event.target === recordingsModal) {
            closeRecordingsModal();
        }
    });

    // Thumbnail Preview Modal
    let thumbnailPreviewOpen = false;
    const thumbnailPreviewModal = document.getElementById('thumbnail-preview-modal');
    const thumbnailPreviewImg = document.getElementById('thumbnail-preview-img');
    const thumbnailPreviewInfo = document.getElementById('thumbnail-preview-info');
    const thumbnailPreviewClose = document.getElementById('thumbnail-preview-close');

    function openThumbnailPreview(thumbUrl, recordingName) {
        thumbnailPreviewOpen = true;
        thumbnailPreviewImg.src = thumbUrl;
        const date = parseRecordingDate(recordingName);
        thumbnailPreviewInfo.textContent = formatRecordingDate(date);
        thumbnailPreviewModal.style.display = 'flex';
    }

    function closeThumbnailPreview() {
        thumbnailPreviewOpen = false;
        thumbnailPreviewModal.style.display = 'none';
        thumbnailPreviewImg.src = '';
    }

    thumbnailPreviewClose?.addEventListener('click', closeThumbnailPreview);

    thumbnailPreviewModal?.addEventListener('click', (event) => {
        if (event.target === thumbnailPreviewModal) {
            closeThumbnailPreview();
        }
    });

    // Close modal with Escape key
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (thumbnailPreviewOpen) {
                closeThumbnailPreview();
            } else if (recordingsModalOpen) {
                closeRecordingsModal();
            }
        }
    });

    // Expose for inline onclick handlers
    window.openThumbnailPreview = openThumbnailPreview;

    // Recordings functionality
    async function fetchRecordings() {
        try {
            const res = await fetch('/api/recordings');
            if (!res.ok) {
                throw new Error('Failed to fetch recordings');
            }
            const data = await res.json();
            renderRecordings(data.recordings || []);
        } catch (error) {
            console.error('[Recordings] Fetch error:', error);
            recordingsListEl.innerHTML = '<p class="muted">録画一覧の取得に失敗しました</p>';
        }
    }

    function parseRecordingDate(filename) {
        // recording_20260204_143052.mp4 -> Date
        const match = filename.match(/recording_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
        if (!match) return null;
        return new Date(match[1], match[2] - 1, match[3], match[4], match[5], match[6]);
    }

    function formatRecordingDate(date) {
        if (!date) return '--';
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const h = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        const s = String(date.getSeconds()).padStart(2, '0');
        return `${y}/${m}/${d} ${h}:${min}:${s}`;
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    function renderRecordings(recordings) {
        if (!recordings || recordings.length === 0) {
            recordingsListEl.innerHTML = `
                <div class="recordings-empty">
                    <div class="recordings-empty-icon">📹</div>
                    <p class="muted">録画がありません</p>
                </div>
            `;
            return;
        }

        // Calculate total size
        const totalBytes = recordings.reduce((sum, rec) => sum + rec.size_bytes, 0);

        recordingsListEl.innerHTML = `
            <div class="recordings-header">
                <span class="recordings-summary">${recordings.length}件 / ${formatFileSize(totalBytes)}</span>
                <button class="recordings-refresh" onclick="window.fetchRecordings()">更新</button>
            </div>
            ${recordings.map(rec => {
                const date = parseRecordingDate(rec.name);
                const dateStr = formatRecordingDate(date);
                const sizeStr = formatFileSize(rec.size_bytes);
                const isH264 = rec.name.endsWith('.h264');
                const thumbUrl = rec.thumbnail
                    ? `/api/recordings/${encodeURIComponent(rec.thumbnail)}`
                    : null;
                return `
                    <div class="recording-card" data-name="${rec.name}">
                        <div class="recording-thumb-container${thumbUrl ? ' clickable' : ''}"
                             ${thumbUrl ? `onclick="window.openThumbnailPreview('${thumbUrl}', '${rec.name}')"` : ''}>
                            ${thumbUrl
                                ? `<img class="recording-thumb" src="${thumbUrl}" alt="" loading="lazy">`
                                : `<div class="recording-thumb-placeholder">📹</div>`
                            }
                        </div>
                        <div class="recording-info">
                            <div class="recording-date">${dateStr}${isH264 ? ' <span style="color:#f0c040;font-size:11px;">(変換中)</span>' : ''}</div>
                            <div class="recording-size">${sizeStr}</div>
                        </div>
                        <div class="recording-actions">
                            <button class="btn-download" onclick="window.downloadRecording('${rec.name}')" title="ダウンロード">
                                ⬇
                            </button>
                            <button class="btn-delete" onclick="window.deleteRecording('${rec.name}')" title="削除">
                                🗑
                            </button>
                        </div>
                    </div>
                `;
            }).join('')}
        `;
    }

    function downloadRecording(filename) {
        const url = `/api/recordings/${encodeURIComponent(filename)}`;
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    async function deleteRecording(filename) {
        if (!confirm(`「${filename}」を削除しますか？`)) return;

        try {
            const res = await fetch(`/api/recordings/${encodeURIComponent(filename)}`, {
                method: 'DELETE'
            });

            if (res.ok) {
                fetchRecordings(); // Refresh list
            } else {
                const data = await res.json();
                alert('削除に失敗しました: ' + (data.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('[Recordings] Delete error:', error);
            alert('削除に失敗しました');
        }
    }

    // Expose for inline onclick handlers
    window.fetchRecordings = fetchRecordings;
    window.downloadRecording = downloadRecording;
    window.deleteRecording = deleteRecording;

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
        // Use protobuf format for efficiency
        const stream = new EventSource('/api/status/stream?format=protobuf');
        stream.addEventListener('message', (event) => {
            if (!event.data) return;
            try {
                // Decode protobuf (base64 -> bytes -> struct)
                const bytes = base64ToBytes(event.data);
                const data = decodeStatusEvent(bytes);
                updateStatus(data);
            } catch (error) {
                console.error('[Status] Protobuf decode error:', error);
                statusBadge.textContent = 'Waiting for data...';
            }
        });
        stream.addEventListener('error', () => {
            stream.close();
            console.warn('[Status] SSE error, falling back to JSON polling');
            fetchStatus();
            setInterval(fetchStatus, 1500);
        });
    }

    const viewerCountEl = document.getElementById('viewer-count');

    function updateViewerCount(data) {
        if (!viewerCountEl) return;
        const viewers = (data.webrtc || 0) + (data.mjpeg || 0);
        viewerCountEl.textContent = viewers;
    }

    function startConnectionStream() {
        const stream = new EventSource('/api/connections/stream');
        stream.addEventListener('connections', (event) => {
            if (!event.data) return;
            try {
                const data = JSON.parse(event.data);
                updateViewerCount(data);
            } catch (error) {
                console.error('[Connections] Parse error:', error);
            }
        });
        stream.addEventListener('error', () => {
            stream.close();
            console.warn('[Connections] SSE error, falling back to polling');
            fetchConnections();
            setInterval(fetchConnections, 2000);
        });

        // Fetch initial count
        fetchConnections();
    }

    async function fetchConnections() {
        try {
            const res = await fetch('/api/connections');
            if (!res.ok) return;
            const data = await res.json();
            updateViewerCount(data);
        } catch (error) {
            console.warn('[Connections] Fetch error:', error);
        }
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

    // Recording functionality using Server-side API
    const RecordingManager = {
        isRecording: false,
        isConverting: false,
        startTime: null,
        timerInterval: null,
        heartbeatInterval: null,
        currentFilename: null,
        statusPollInterval: null,

        // Update UI elements
        updateUI(statusText = null) {
            const recordBtn = document.getElementById('record-btn');
            const recordStatus = document.getElementById('record-status');

            // Handle converting state (disabled button)
            if (this.isConverting) {
                recordBtn?.classList.add('converting');
                recordBtn?.classList.remove('recording');
                if (recordBtn) recordBtn.disabled = true;
                if (recordStatus) {
                    recordStatus.classList.add('converting');
                    recordStatus.classList.remove('recording');
                    recordStatus.textContent = statusText || '処理中...';
                }
                return;
            }

            // Remove converting state
            recordBtn?.classList.remove('converting');
            if (recordBtn) recordBtn.disabled = false;
            recordStatus?.classList.remove('converting');

            if (this.isRecording) {
                recordBtn?.classList.add('recording');
                if (recordStatus) {
                    recordStatus.classList.add('recording');
                    if (statusText) {
                        recordStatus.textContent = statusText;
                    } else {
                        this.updateTimer();
                    }
                }
            } else {
                recordBtn?.classList.remove('recording');
                if (recordStatus) {
                    recordStatus.classList.remove('recording');
                    recordStatus.textContent = statusText || '';
                }
            }
        },

        // Update recording timer display
        updateTimer() {
            // Don't update if not recording or converting
            if (!this.isRecording || this.isConverting) return;

            const recordStatus = document.getElementById('record-status');
            if (!recordStatus || !this.startTime) return;

            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            recordStatus.textContent = `REC ${minutes}:${seconds}`;
        },

        // Start recording via server API
        async start() {
            try {
                this.updateUI('Starting...');

                const res = await fetch('/api/recording/start', { method: 'POST' });
                const data = await res.json();

                if (!res.ok) {
                    throw new Error(data.error || 'Failed to start recording');
                }

                this.isRecording = true;
                this.startTime = Date.now();
                this.currentFilename = data.file;

                // Start timer update
                this.timerInterval = setInterval(() => this.updateTimer(), 1000);

                // Start heartbeat (every 1 second, timeout is 3 seconds)
                this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 1000);

                this.updateUI();
                console.log('[Recording] Started:', this.currentFilename);
                return true;

            } catch (error) {
                console.error('[Recording] Failed to start:', error);
                alert('録画の開始に失敗しました: ' + error.message);
                this.updateUI();
                return false;
            }
        },

        // Stop recording via server API
        async stop() {
            if (!this.isRecording) return;

            try {
                this.updateUI('Stopping...');

                const res = await fetch('/api/recording/stop', { method: 'POST' });
                const data = await res.json();

                if (!res.ok) {
                    throw new Error(data.error || 'Failed to stop recording');
                }

                // Clear intervals first to prevent race conditions
                if (this.timerInterval) {
                    clearInterval(this.timerInterval);
                    this.timerInterval = null;
                }

                if (this.heartbeatInterval) {
                    clearInterval(this.heartbeatInterval);
                    this.heartbeatInterval = null;
                }

                this.isRecording = false;
                this.isConverting = true;

                console.log('[Recording] Stopped:', data.file);

                // Show converting status
                this.updateUI('変換中...');

                // Refresh recordings list if modal is open
                if (recordingsModalOpen) {
                    fetchRecordings();
                }
                await this.waitForConversionAndDownload(data.file);

            } catch (error) {
                console.error('[Recording] Failed to stop:', error);
                alert('録画の停止に失敗しました: ' + error.message);
            } finally {
                this.isConverting = false;
                this.updateUI();
            }
        },

        // Wait for conversion to complete and auto-download
        async waitForConversionAndDownload(h264Filename) {
            const mp4Filename = h264Filename.replace('.h264', '.mp4');
            const maxWaitMs = 120000; // 120 seconds max
            const pollIntervalMs = 500;
            const startTime = Date.now();

            console.log('[Recording] Waiting for conversion:', mp4Filename);

            while (Date.now() - startTime < maxWaitMs) {
                try {
                    // Check recording status to see if conversion is complete
                    const statusRes = await fetch('/api/recording/status');
                    if (statusRes.ok) {
                        const status = await statusRes.json();
                        if (!status.converting) {
                            // Conversion complete - check for MP4 file
                            const listRes = await fetch('/api/recordings');
                            if (listRes.ok) {
                                const data = await listRes.json();
                                const mp4File = data.recordings?.find(r => r.name === mp4Filename);
                                if (mp4File) {
                                    console.log('[Recording] Conversion complete, downloading:', mp4Filename);
                                    // Refresh recordings list if modal is open
                                    if (recordingsModalOpen) {
                                        fetchRecordings();
                                    }
                                    this.download(mp4Filename);
                                    return;
                                }
                            }
                            // Conversion done but no MP4 - something went wrong
                            console.warn('[Recording] Conversion finished but MP4 not found');
                            return;
                        }
                    }
                } catch (error) {
                    console.warn('[Recording] Poll error:', error);
                }

                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            }

            // Timeout - offer H.264 download instead
            console.warn('[Recording] Conversion timeout, offering H.264 download');
            if (confirm('MP4変換がタイムアウトしました。H.264ファイルをダウンロードしますか？')) {
                this.download(h264Filename);
            }
        },

        // Download recording from server
        download(filename) {
            const url = `/api/recordings/${encodeURIComponent(filename)}`;
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            console.log('[Recording] Downloaded:', filename);
        },

        // Send heartbeat to prevent auto-stop
        async sendHeartbeat() {
            if (!this.isRecording) return;

            try {
                const res = await fetch('/api/recording/heartbeat', { method: 'POST' });
                if (!res.ok) {
                    // Recording was auto-stopped on server side
                    console.warn('[Recording] Heartbeat failed, recording may have stopped');
                    this.isRecording = false;
                    if (this.timerInterval) {
                        clearInterval(this.timerInterval);
                        this.timerInterval = null;
                    }
                    if (this.heartbeatInterval) {
                        clearInterval(this.heartbeatInterval);
                        this.heartbeatInterval = null;
                    }
                    this.updateUI('Auto-stopped');
                }
            } catch (error) {
                console.warn('[Recording] Heartbeat error:', error);
            }
        },

        // Toggle recording
        async toggle() {
            if (this.isRecording) {
                await this.stop();
            } else {
                await this.start();
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
    startConnectionStream();
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
