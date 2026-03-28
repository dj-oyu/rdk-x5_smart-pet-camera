import { useEffect, useCallback } from 'preact/hooks';
import { useSignal } from '@preact/signals';

interface Recording {
  name: string;
  size_bytes: number;
  thumbnail?: string;
}

interface Props {
  onClose: () => void;
  onOpenThumbnail: (url: string, name: string) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function parseRecordingDate(filename: string): Date | null {
  const match = filename.match(/recording_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  return new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
}

function formatDate(date: Date | null): string {
  if (!date) return '--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function RecordingsModal({ onClose, onOpenThumbnail }: Props) {
  const recordings = useSignal<Recording[]>([]);

  const fetchRecordings = useCallback(async () => {
    try {
      const res = await fetch('/api/recordings');
      if (!res.ok) return;
      const data = await res.json();
      recordings.value = data.recordings || [];
    } catch { /* ignore */ }
  }, []);

  // マウント時に一度フェッチ
  useEffect(() => {
    fetchRecordings();
  }, []);

  const recs = recordings.value;
  const totalBytes = recs.reduce((sum, r) => sum + r.size_bytes, 0);

  const downloadRecording = (name: string) => {
    const a = document.createElement('a');
    a.href = `/api/recordings/${encodeURIComponent(name)}`;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const deleteRecording = async (name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    try {
      const res = await fetch(`/api/recordings/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (res.ok) fetchRecordings();
      else {
        const data = await res.json();
        alert('Delete failed: ' + (data.error || 'Unknown error'));
      }
    } catch { alert('Delete failed'); }
  };

  return (
    <div class="modal-overlay" style={{ display: 'flex' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal-content">
        <div class="modal-header">
          <h3>Recordings</h3>
          <button class="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div class="modal-body">
          <div class="recordings-list">
            {recs.length === 0 ? (
              <div class="recordings-empty">
                <p class="muted">No recordings</p>
              </div>
            ) : (
              <>
                <div class="recordings-header">
                  <span class="recordings-summary">{recs.length} files / {formatFileSize(totalBytes)}</span>
                  <button class="recordings-refresh" onClick={fetchRecordings}>Refresh</button>
                </div>
                {recs.map((rec) => {
                  const date = parseRecordingDate(rec.name);
                  const thumbUrl = rec.thumbnail ? `/api/recordings/${encodeURIComponent(rec.thumbnail)}` : null;
                  const isH264 = rec.name.endsWith('.h264');
                  return (
                    <div class="recording-card" key={rec.name}>
                      <div
                        class={`recording-thumb-container${thumbUrl ? ' clickable' : ''}`}
                        onClick={() => thumbUrl && onOpenThumbnail(thumbUrl, rec.name)}
                      >
                        {thumbUrl ? (
                          <img class="recording-thumb" src={thumbUrl} alt="" loading="lazy" />
                        ) : (
                          <div class="recording-thumb-placeholder">📹</div>
                        )}
                      </div>
                      <div class="recording-info">
                        <div class="recording-date">
                          {formatDate(date)}
                          {isH264 && <span style="color:#f0c040;font-size:11px;"> (converting)</span>}
                        </div>
                        <div class="recording-size">{formatFileSize(rec.size_bytes)}</div>
                      </div>
                      <div class="recording-actions">
                        <button class="btn-download" onClick={() => downloadRecording(rec.name)} title="Download">⬇</button>
                        <button class="btn-delete" onClick={() => deleteRecording(rec.name)} title="Delete">🗑</button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
