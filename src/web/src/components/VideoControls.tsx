import { useState, useCallback } from 'preact/hooks';
import type { RecordingState } from '../hooks/useRecording';

interface Props {
  mode: 'webrtc' | 'mjpeg';
  onSwitchWebRTC: () => void;
  onSwitchMJPEG: () => void;
  recording: RecordingState;
  onToggleRecording: () => void;
  onOpenRecordings: () => void;
}

type CaptureState = 'idle' | 'capturing' | 'ok' | 'error';

export function VideoControls({
  mode,
  onSwitchWebRTC,
  onSwitchMJPEG,
  recording,
  onToggleRecording,
  onOpenRecordings,
}: Props) {
  const [captureState, setCaptureState] = useState<CaptureState>('idle');

  const handleCapture = useCallback(async () => {
    if (captureState === 'capturing') return;
    setCaptureState('capturing');
    try {
      // 4-panel comic capture takes ~4-12s (randomized intervals)
      const res = await fetch('/api/comic-capture', { method: 'POST' });
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
    setTimeout(() => setCaptureState('idle'), 3000);
  }, [captureState]);

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
        <button
          class={`btn-capture${captureState !== 'idle' ? ` capture-${captureState}` : ''}`}
          title="Capture snapshot"
          onClick={handleCapture}
          disabled={captureState === 'capturing'}
        >
          <span class="capture-icon" />
        </button>
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
