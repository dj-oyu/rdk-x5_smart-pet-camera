import { useEffect, useCallback } from 'preact/hooks';
import { useSignal, useModel } from '@preact/signals';
import { Show } from '@preact/signals/utils';
import { useVideoPlayer } from './components/VideoPlayer';
import { VideoControls } from './components/VideoControls';
import { RecordingsModal } from './components/RecordingsModal';
import { useSidebar, TrackingView } from './components/Sidebar';
import { AlbumView } from './components/AlbumView';
import { MobileTabBar } from './components/MobileTabBar';
import { useSSE } from './hooks/useSSE';
import { useRecording } from './hooks/useRecording';
import type { StatusEvent } from './lib/protobuf';
import { AppStore } from './lib/store';

type PreviewState =
  | { type: 'image'; url: string; name: string }
  | { type: 'video'; url: string; name: string };

function ThumbnailPreview({
  preview,
  onClose,
  parseDateFromName,
}: {
  preview: PreviewState;
  onClose: () => void;
  parseDateFromName: (name: string) => string;
}) {
  const videoError = useSignal(false);

  return (
    <div
      class="modal-overlay thumbnail-preview-modal"
      style={{ display: 'flex' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="thumbnail-preview-content">
        <button class="thumbnail-preview-close" onClick={onClose}>&times;</button>
        {preview.type === 'video' ? (
          videoError.value ? (
            <div class="thumbnail-preview-fallback">
              H.265 の再生に非対応のブラウザです。ダウンロードしてご覧ください。
            </div>
          ) : (
            <video
              class="thumbnail-preview-video"
              src={preview.url}
              controls
              autoplay
              playsinline
              onError={() => { videoError.value = true; }}
            />
          )
        ) : (
          <img class="thumbnail-preview-img" src={preview.url} alt="Thumbnail" />
        )}
        <div class="thumbnail-preview-info">{parseDateFromName(preview.name)}</div>
      </div>
    </div>
  );
}

export function App() {
  const store = useModel(AppStore);

  const sidebar = useSidebar();

  const onStatus = useCallback(
    (data: StatusEvent) => {
      sidebar.updateTrajectory(data.latest_detection);
    },
    [sidebar.updateTrajectory],
  );

  const videoPlayer = useVideoPlayer({ onStatus });

  const sse = useSSE({
    onDetection: videoPlayer.handleDetection,
    onStatus: videoPlayer.handleStatus,
    onViewerCount: (count) => { store.viewerCount.value = String(count); },
  });

  useEffect(() => {
    // Start after DOM mount so videoRef is attached
    videoPlayer.startWebRTC();
    sse.start();
    return () => sse.stop();
  }, []);

  const { toggle: toggleRecording } = useRecording(store.recording);

  // Escape キー: store の dismissTopModal が signal を直接読むため deps 不要
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.dismissTopModal();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const parseDateFromName = (name: string) => {
    const match = name.match(/(?:recording|comic)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (!match) return '';
    const d = new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const mobileTab = store.mobileTab.value;
  const thumbnailPreview = store.thumbnailPreview.value;

  return (
    <div class="app">
      <div class="main-content">
        <div class="left-column">
          <div class={`video-container ${mobileTab !== 'live' ? 'mobile-hidden' : ''}`}>
            <div id="video-panel">
              <div
                id="webrtc-view"
                style={{
                  position: 'relative',
                  width: '100%',
                  display: videoPlayer.mode.value === 'webrtc' ? 'block' : 'none',
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
              <div id="mjpeg-view" style={{ display: videoPlayer.mode.value === 'mjpeg' ? 'block' : 'none' }}>
                <img
                  ref={videoPlayer.mjpegRef}
                  alt="Camera stream"
                  style={{ width: '100%', height: 'auto', borderRadius: '8px 8px 0 0' }}
                />
              </div>
            </div>
            <VideoControls
              mode={videoPlayer.mode.value}
              onSwitchWebRTC={videoPlayer.switchToWebRTC}
              onSwitchMJPEG={videoPlayer.switchToMJPEG}
              recording={store.recording.value}
              onToggleRecording={toggleRecording}
              onOpenRecordings={store.openRecordings}
              viewerCount={store.viewerCount.value}
            />
          </div>
          <div class={mobileTab === 'album' ? 'mobile-hidden' : ''}>
            <TrackingView
              canvasRef={sidebar.canvasRef}
              ganttCanvasRef={sidebar.ganttCanvasRef}
              legendEntries={sidebar.legendEntries.value}
            />
          </div>
        </div>

        <div class={`sidebar ${mobileTab === 'tracking' ? 'mobile-hidden' : ''}`}>
          <AlbumView />
        </div>

        <Show when={store.recordingsOpen}>
          {() => (
            <RecordingsModal
              onClose={store.closeRecordings}
              onOpenThumbnail={store.openThumbnail}
              onPlayVideo={store.openVideoPlayer}
            />
          )}
        </Show>

        {thumbnailPreview && (
          <ThumbnailPreview
            preview={thumbnailPreview}
            onClose={store.closeThumbnail}
            parseDateFromName={parseDateFromName}
          />
        )}
      </div>
      <MobileTabBar activeTab={mobileTab} onTabChange={(tab) => { store.mobileTab.value = tab; }} />
    </div>
  );
}
