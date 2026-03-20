import { render } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { useVideoPlayer } from './components/VideoPlayer';
import { VideoControls } from './components/VideoControls';
import { RecordingsModal } from './components/RecordingsModal';
import { useSidebar, SidebarView } from './components/Sidebar';
import { useSSE } from './hooks/useSSE';
import { useRecording } from './hooks/useRecording';
import type { StatusEvent } from './lib/protobuf';

function App() {
  const [statusBadge, setStatusBadge] = useState('Waiting for data...');
  const [viewerCount, setViewerCount] = useState('-');
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [thumbnailPreview, setThumbnailPreview] = useState<{ url: string; name: string } | null>(null);

  const openThumbnail = useCallback((url: string, name: string) => {
    setThumbnailPreview({ url, name });
  }, []);

  const sidebar = useSidebar(openThumbnail);

  const onStatus = useCallback(
    (data: StatusEvent) => {
      if (data.shared_memory) {
        setStatusBadge(
          data.shared_memory.has_detection ? 'Receiving detections' : 'Live stream active',
        );
      }
      sidebar.updateTrajectory(data.latest_detection);
    },
    [sidebar.updateTrajectory],
  );

  const videoPlayer = useVideoPlayer({ onStatus });

  const sse = useSSE({
    onDetection: videoPlayer.handleDetection,
    onStatus: videoPlayer.handleStatus,
    onViewerCount: (count) => setViewerCount(String(count)),
  });

  useEffect(() => {
    sse.startDetectionStream();
    sse.startStatusStream();
    sse.startConnectionStream();
    return () => sse.stop();
  }, []);

  const { state: recordingState, toggle: toggleRecording } = useRecording();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (thumbnailPreview) setThumbnailPreview(null);
        else if (recordingsOpen) setRecordingsOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [thumbnailPreview, recordingsOpen]);

  const parseDateFromName = (name: string) => {
    const match = name.match(/(?:recording|comic)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (!match) return '';
    const d = new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  return (
    <div class="app">
      <div class="header">
        <div class="title">Smart Pet Camera Monitor</div>
        <span class="badge badge-secondary">{statusBadge}</span>
        <div class="viewer-count">
          <span class="viewer-icon">👁</span>
          <span>{viewerCount}</span>
        </div>
      </div>

      <div class="main-content">
        <div class="video-container">
          <div id="video-panel">
            <div
              id="webrtc-view"
              style={{
                position: 'relative',
                width: '100%',
                display: videoPlayer.mode === 'webrtc' ? 'block' : 'none',
              }}
            >
              <video
                ref={videoPlayer.videoRef}
                autoplay
                playsinline
                muted
                style={{
                  width: '100%',
                  height: 'auto',
                  display: 'block',
                  background: '#000',
                  borderRadius: '8px 8px 0 0',
                }}
              />
              <canvas
                ref={videoPlayer.canvasRef}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none',
                }}
              />
            </div>
            <div id="mjpeg-view" style={{ display: videoPlayer.mode === 'mjpeg' ? 'block' : 'none' }}>
              <img
                ref={videoPlayer.mjpegRef}
                alt="Camera stream"
                style={{ width: '100%', height: 'auto', borderRadius: '8px 8px 0 0' }}
              />
            </div>
          </div>
          <VideoControls
            mode={videoPlayer.mode}
            onSwitchWebRTC={videoPlayer.switchToWebRTC}
            onSwitchMJPEG={videoPlayer.switchToMJPEG}
            recording={recordingState}
            onToggleRecording={toggleRecording}
            onOpenRecordings={() => setRecordingsOpen(true)}
          />
        </div>

        <RecordingsModal
          open={recordingsOpen}
          onClose={() => setRecordingsOpen(false)}
          onOpenThumbnail={openThumbnail}
        />

        {thumbnailPreview && (
          <div
            class="modal-overlay thumbnail-preview-modal"
            style={{ display: 'flex' }}
            onClick={(e) => {
              if (e.target === e.currentTarget) setThumbnailPreview(null);
            }}
          >
            <div class="thumbnail-preview-content">
              <button class="thumbnail-preview-close" onClick={() => setThumbnailPreview(null)}>&times;</button>
              <img class="thumbnail-preview-img" src={thumbnailPreview.url} alt="Thumbnail" />
              <div class="thumbnail-preview-info">{parseDateFromName(thumbnailPreview.name)}</div>
            </div>
          </div>
        )}

        <SidebarView {...sidebar} />
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
