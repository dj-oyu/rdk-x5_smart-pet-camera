import { useRef, useCallback, useEffect } from 'preact/hooks';
import type { Signal } from '@preact/signals';

export interface RecordingState {
  isRecording: boolean;
  isConverting: boolean;
  isStopping: boolean;
  statusText: string;
}

export function useRecording(recordingState: Signal<RecordingState>) {
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRecordingRef = useRef(false);
  const isStoppingRef = useRef(false);

  const clearIntervals = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
  }, []);

  const formatElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `REC ${m}:${sec}`;
  };

  const sendHeartbeat = useCallback(async () => {
    if (!isRecordingRef.current) return;
    try {
      const res = await fetch('/api/recording/heartbeat', { method: 'POST' });
      if (!res.ok) {
        isRecordingRef.current = false;
        clearIntervals();
        recordingState.value = { isRecording: false, isConverting: false, isStopping: false, statusText: 'Auto-stopped' };
      }
    } catch { /* ignore */ }
  }, [clearIntervals]);

  const download = (filename: string) => {
    const a = document.createElement('a');
    a.href = `/api/recordings/${encodeURIComponent(filename)}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const waitForConversion = useCallback(async (h264Filename: string) => {
    const mp4Filename = h264Filename.replace('.hevc', '.mp4').replace('.h264', '.mp4');
    const maxWaitMs = 120000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const statusRes = await fetch('/api/recording/status');
        if (statusRes.ok) {
          const status = await statusRes.json();

          if (status.converting) {
            const pct = typeof status.convert_progress === 'number' ? status.convert_progress : 0;
            recordingState.value = { ...recordingState.peek(), statusText: `Converting... ${Math.round(pct * 100)}%` };
          }

          if (!status.converting) {
            const listRes = await fetch('/api/recordings');
            if (listRes.ok) {
              const data = await listRes.json();
              const mp4File = data.recordings?.find((r: { name: string }) => r.name === mp4Filename);
              if (mp4File) {
                download(mp4Filename);
                return;
              }
            }
            return;
          }
        }
      } catch { /* ignore */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (confirm('MP4 conversion timed out. Download H.264 file?')) {
      download(h264Filename);
    }
  }, []);

  const start = useCallback(async () => {
    recordingState.value = { ...recordingState.peek(), statusText: 'Starting...' };
    try {
      const res = await fetch('/api/recording/start', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start recording');

      isRecordingRef.current = true;
      startTimeRef.current = Date.now();

      timerRef.current = setInterval(() => {
        if (!isRecordingRef.current) return;
        recordingState.value = {
          ...recordingState.peek(),
          statusText: formatElapsed(Date.now() - startTimeRef.current),
        };
      }, 1000);
      heartbeatRef.current = setInterval(sendHeartbeat, 1000);

      recordingState.value = { isRecording: true, isConverting: false, isStopping: false, statusText: formatElapsed(0) };
      return data.file as string;
    } catch (error) {
      alert('Recording start failed: ' + (error as Error).message);
      recordingState.value = { isRecording: false, isConverting: false, isStopping: false, statusText: '' };
      return null;
    }
  }, [sendHeartbeat]);

  const stop = useCallback(async () => {
    if (!isRecordingRef.current || isStoppingRef.current) return;
    isStoppingRef.current = true;

    // Stop timer/heartbeat immediately — don't wait for API response
    clearIntervals();
    isRecordingRef.current = false;
    recordingState.value = { isRecording: false, isConverting: false, isStopping: true, statusText: 'Stopping...' };

    try {
      const res = await fetch('/api/recording/stop', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to stop recording');

      recordingState.value = { isRecording: false, isConverting: true, isStopping: false, statusText: 'Converting...' };

      await waitForConversion(data.file);
    } catch (error) {
      alert('Recording stop failed: ' + (error as Error).message);
    } finally {
      isStoppingRef.current = false;
      recordingState.value = { isRecording: false, isConverting: false, isStopping: false, statusText: '' };
    }
  }, [clearIntervals, waitForConversion]);

  const toggle = useCallback(async () => {
    if (isStoppingRef.current) return;
    if (isRecordingRef.current) {
      await stop();
    } else {
      await start();
    }
  }, [start, stop]);

  useEffect(() => {
    return () => clearIntervals();
  }, [clearIntervals]);

  return { toggle };
}
