import { useState, useRef, useCallback, useEffect } from 'preact/hooks';

export interface RecordingState {
  isRecording: boolean;
  isConverting: boolean;
  statusText: string;
}

export function useRecording() {
  const [state, setState] = useState<RecordingState>({
    isRecording: false,
    isConverting: false,
    statusText: '',
  });

  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRecordingRef = useRef(false);

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
        setState({ isRecording: false, isConverting: false, statusText: 'Auto-stopped' });
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
    const mp4Filename = h264Filename.replace('.h264', '.mp4');
    const maxWaitMs = 120000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const statusRes = await fetch('/api/recording/status');
        if (statusRes.ok) {
          const status = await statusRes.json();
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
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (confirm('MP4 conversion timed out. Download H.264 file?')) {
      download(h264Filename);
    }
  }, []);

  const start = useCallback(async () => {
    setState((s) => ({ ...s, statusText: 'Starting...' }));
    try {
      const res = await fetch('/api/recording/start', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start recording');

      isRecordingRef.current = true;
      startTimeRef.current = Date.now();

      timerRef.current = setInterval(() => {
        if (!isRecordingRef.current) return;
        setState((s) => ({
          ...s,
          statusText: formatElapsed(Date.now() - startTimeRef.current),
        }));
      }, 1000);
      heartbeatRef.current = setInterval(sendHeartbeat, 1000);

      setState({ isRecording: true, isConverting: false, statusText: formatElapsed(0) });
      return data.file as string;
    } catch (error) {
      alert('Recording start failed: ' + (error as Error).message);
      setState({ isRecording: false, isConverting: false, statusText: '' });
      return null;
    }
  }, [sendHeartbeat]);

  const stop = useCallback(async () => {
    if (!isRecordingRef.current) return;

    setState((s) => ({ ...s, statusText: 'Stopping...' }));
    try {
      const res = await fetch('/api/recording/stop', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to stop recording');

      clearIntervals();
      isRecordingRef.current = false;
      setState({ isRecording: false, isConverting: true, statusText: 'Converting...' });

      await waitForConversion(data.file);
    } catch (error) {
      alert('Recording stop failed: ' + (error as Error).message);
    } finally {
      setState({ isRecording: false, isConverting: false, statusText: '' });
    }
  }, [clearIntervals, waitForConversion]);

  const toggle = useCallback(async () => {
    if (isRecordingRef.current) {
      await stop();
    } else {
      await start();
    }
  }, [start, stop]);

  useEffect(() => {
    return () => clearIntervals();
  }, [clearIntervals]);

  return { state, toggle };
}
