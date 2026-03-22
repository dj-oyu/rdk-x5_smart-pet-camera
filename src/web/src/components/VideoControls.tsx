import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import type { RecordingState } from '../hooks/useRecording';

interface Props {
  mode: 'webrtc' | 'mjpeg';
  onSwitchWebRTC: () => void;
  onSwitchMJPEG: () => void;
  recording: RecordingState;
  onToggleRecording: () => void;
  onOpenRecordings: () => void;
}

type CaptureState = 'idle' | 'input' | 'capturing' | 'ok' | 'error';

export function VideoControls({
  mode,
  onSwitchWebRTC,
  onSwitchMJPEG,
  recording,
  onToggleRecording,
  onOpenRecordings,
}: Props) {
  const [captureState, setCaptureState] = useState<CaptureState>('idle');
  const [captionText, setCaptionText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when bubble opens
  useEffect(() => {
    if (captureState === 'input' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [captureState]);

  const handleCaptureClick = useCallback(() => {
    if (captureState === 'capturing') return;
    if (captureState === 'idle') {
      // First click: open text input bubble
      setCaptureState('input');
    } else if (captureState === 'input') {
      // Second click (on button): close without capturing
      setCaptureState('idle');
      setCaptionText('');
    }
  }, [captureState]);

  const doCapture = useCallback(async () => {
    setCaptureState('capturing');
    try {
      const res = await fetch('/api/comic-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: captionText }),
      });
      if (res.ok) {
        const data = await res.json();
        setCaptureState('ok');
        console.log('[Comic] Saved:', data.filename);
      } else {
        setCaptureState('error');
      }
    } catch {
      setCaptureState('error');
    }
    setCaptionText('');
    setTimeout(() => setCaptureState('idle'), 3000);
  }, [captionText]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doCapture();
      } else if (e.key === 'Escape') {
        setCaptureState('idle');
        setCaptionText('');
      }
    },
    [doCapture],
  );

  const recBtnClass = [
    'record-btn',
    recording.isRecording ? 'recording' : '',
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

  const captureBtnClass = [
    'btn-capture',
    captureState !== 'idle' && captureState !== 'input' ? `capture-${captureState}` : '',
    captureState === 'input' ? 'capture-active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div class="video-controls">
      <div class="view-toggle">
        <button type="button" class={mode === 'webrtc' ? 'active' : ''} onClick={onSwitchWebRTC}>
          WebRTC
        </button>
        <button type="button" class={mode === 'mjpeg' ? 'active' : ''} onClick={onSwitchMJPEG}>
          MJPEG
        </button>
      </div>
      <div class="record-controls">
        <button class="btn-recordings" title="Recordings" onClick={onOpenRecordings}>
          <span class="recordings-icon" />
        </button>
        <div class="capture-wrapper">
          <button
            class={captureBtnClass}
            title={captureState === 'input' ? 'Cancel' : '4-panel comic capture'}
            onClick={handleCaptureClick}
            disabled={captureState === 'capturing'}
          >
            <span class="capture-icon" />
          </button>
          {captureState === 'input' && (
            <div class="capture-bubble">
              <div class="capture-bubble-arrow" />
              <input
                ref={inputRef}
                type="text"
                class="capture-input"
                placeholder="キャプション (Enter で撮影)"
                value={captionText}
                onInput={(e) => setCaptionText((e.target as HTMLInputElement).value)}
                onKeyDown={handleKeyDown}
                maxLength={50}
              />
              <button class="capture-send" onClick={doCapture} disabled={captureState === 'capturing'}>
                📸
              </button>
            </div>
          )}
        </div>
        <button
          class={recBtnClass}
          title="REC"
          onClick={onToggleRecording}
          disabled={recording.isConverting}
        >
          <span class="record-icon" />
        </button>
        {showStatus && <span class={statusClass}>{recording.statusText}</span>}
      </div>
    </div>
  );
}
