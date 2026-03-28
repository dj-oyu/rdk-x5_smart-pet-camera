import { useCallback, useRef } from 'preact/hooks';
import { useSignal, useSignalEffect, useModel } from '@preact/signals';
import { AppStore } from '../lib/store';

interface Props {
  mode: 'webrtc' | 'mjpeg';
  onSwitchWebRTC: () => void;
  onSwitchMJPEG: () => void;
  onToggleRecording: () => void;
  onOpenRecordings: () => void;
  viewerCount: string;
}

type CaptureState = 'idle' | 'input' | 'capturing' | 'ok' | 'error';

export function VideoControls({
  mode,
  onSwitchWebRTC,
  onSwitchMJPEG,
  onToggleRecording,
  onOpenRecordings,
  viewerCount,
}: Props) {
  const { recording: recordingSignal } = useModel(AppStore);
  const recording = recordingSignal.value;
  const captureState = useSignal<CaptureState>('idle');
  const captionText = useSignal('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when bubble opens
  useSignalEffect(() => {
    if (captureState.value === 'input' && inputRef.current) {
      inputRef.current.focus();
    }
  });

  const doCapture = useCallback(async () => {
    captureState.value = 'capturing';
    try {
      const res = await fetch('/api/comic-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: captionText.value }),
      });
      if (res.ok) {
        const data = await res.json();
        captureState.value = 'ok';
        console.log('[Comic] Saved:', data.filename);
      } else {
        captureState.value = 'error';
      }
    } catch {
      captureState.value = 'error';
    }
    captionText.value = '';
    setTimeout(() => { captureState.value = 'idle'; }, 3000);
  }, []);

  const handleCaptureClick = useCallback(() => {
    if (captureState.value === 'capturing') return;
    if (captureState.value === 'idle') {
      captureState.value = 'input';
    } else if (captureState.value === 'input') {
      // Second click: capture immediately (Escape to cancel)
      doCapture();
    }
  }, [doCapture]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doCapture();
      } else if (e.key === 'Escape') {
        captureState.value = 'idle';
        captionText.value = '';
      }
    },
    [doCapture],
  );

  const recBtnClass = [
    'record-btn',
    recording.isRecording ? 'recording' : '',
    recording.isStopping ? 'stopping' : '',
    recording.isConverting ? 'converting' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const statusClass = [
    'record-status',
    recording.isRecording ? 'recording' : '',
    recording.isConverting ? 'converting' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const showStatus = recording.isRecording || recording.isConverting;

  const cs = captureState.value;
  const captureBtnClass = [
    'btn-capture',
    cs !== 'idle' && cs !== 'input' ? `capture-${cs}` : '',
    cs === 'input' ? 'capture-active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div class="video-controls">
      <div class="controls-secondary">
        <div class="view-toggle">
          <button type="button" class={mode === 'webrtc' ? 'active' : ''} onClick={onSwitchWebRTC}>
            HD
          </button>
          <button type="button" class={mode === 'mjpeg' ? 'active' : ''} onClick={onSwitchMJPEG}>
            Lite
          </button>
        </div>
      </div>
      <div class="viewer-count">
        <span class="viewer-icon">👁</span>
        <span>{viewerCount}</span>
      </div>
      <div class="controls-primary">
        <button class="btn-recordings" title="Recordings" onClick={onOpenRecordings}>
          <span class="recordings-icon" />
        </button>
        <div class="capture-wrapper">
          <button
            class={captureBtnClass}
            title={cs === 'input' ? 'Capture now' : '4-panel comic capture'}
            onClick={handleCaptureClick}
            disabled={cs === 'capturing'}
          >
            <span class="capture-icon" />
          </button>
          {cs === 'input' && (
            <div class="capture-bubble">
              <div class="capture-bubble-arrow" />
              <input
                ref={inputRef}
                type="text"
                class="capture-input"
                placeholder="キャプション (Enter で撮影)"
                value={captionText.value}
                onInput={(e) => { captionText.value = (e.target as HTMLInputElement).value; }}
                onKeyDown={handleKeyDown}
                maxLength={50}
              />
              <button class="capture-send" onClick={doCapture}>
                📸
              </button>
            </div>
          )}
        </div>
        <button
          class={recBtnClass}
          title="REC"
          onClick={onToggleRecording}
          disabled={recording.isConverting || recording.isStopping}
        >
          <span class="record-icon" />
        </button>
        {showStatus && <span class={statusClass}>{recording.statusText}</span>}
      </div>
    </div>
  );
}
