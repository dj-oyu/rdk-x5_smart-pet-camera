import { useSignal, useComputed } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import {
  syncFrames,
  fetchFrames,
  fetchTrainingStats,
  updateFrameStatus,
  cleanupRejected,
  type TrainingFrame,
  type TrainingStats,
} from "../../lib/training-api";
import { AnnotateCanvas } from "./annotate-canvas";

type StatusFilter = "all" | "pending" | "approved" | "rejected";

export function AnnotatePage() {
  const frames = useSignal<TrainingFrame[]>([]);
  const total = useSignal(0);
  const stats = useSignal<TrainingStats | null>(null);
  const loading = useSignal(false);
  const syncing = useSignal(false);
  const filter = useSignal<StatusFilter>("pending");
  const offset = useSignal(0);
  const selectedFrame = useSignal<TrainingFrame | null>(null);
  const showCleanup = useSignal(false);
  const limit = 20;

  const loadFrames = async () => {
    loading.value = true;
    try {
      const statusParam = filter.value === "all" ? undefined : filter.value;
      const data = await fetchFrames(statusParam, limit, offset.value);
      frames.value = data.frames;
      total.value = data.total;
    } finally {
      loading.value = false;
    }
  };

  const loadStats = async () => {
    try {
      stats.value = await fetchTrainingStats();
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadFrames();
    loadStats();
  }, []);

  useEffect(() => {
    loadFrames();
  }, [filter.value, offset.value]);

  const handleSync = async () => {
    syncing.value = true;
    try {
      const result = await syncFrames();
      alert(`Synced: ${result.synced} frames (${result.total_remote} remote)`);
      await loadFrames();
      await loadStats();
    } catch (e) {
      alert(`Sync failed: ${e}`);
    } finally {
      syncing.value = false;
    }
  };

  const handleStatusChange = async (frame: TrainingFrame, status: "approved" | "rejected") => {
    try {
      await updateFrameStatus(frame.id, status);
      // Update local state
      frames.value = frames.value.map((f) =>
        f.id === frame.id ? { ...f, status } : f,
      );
      loadStats();
    } catch (e) {
      alert(`Failed: ${e}`);
    }
  };

  const handleFrameClick = (frame: TrainingFrame) => {
    selectedFrame.value = frame;
  };

  const handleAnnotateDone = () => {
    selectedFrame.value = null;
    loadFrames();
    loadStats();
  };

  const pageCount = useComputed(() => Math.ceil(total.value / limit));
  const currentPage = useComputed(() => Math.floor(offset.value / limit) + 1);

  // If a frame is selected, show annotation canvas
  if (selectedFrame.value) {
    return (
      <AnnotateCanvas
        frame={selectedFrame.value}
        onDone={handleAnnotateDone}
        onStatusChange={handleStatusChange}
      />
    );
  }

  return (
    <div class="training-page">
      <header class="training-header">
        <h1>Training Dataset</h1>
        <button
          class="btn-cleanup"
          onClick={() => (showCleanup.value = true)}
          disabled={!stats.value || stats.value.rejected === 0}
          title={
            stats.value && stats.value.rejected > 0
              ? `${stats.value.rejected} rejected frames`
              : "No rejected frames"
          }
        >
          Cleanup ({stats.value?.rejected ?? 0} rejected)
        </button>
        <button
          class="btn-sync"
          onClick={handleSync}
          disabled={syncing.value}
        >
          {syncing.value ? "Syncing..." : "Sync from RDK X5"}
        </button>
      </header>

      {stats.value && (
        <div class="training-stats">
          <span class="stat">Total: {stats.value.total}</span>
          <span class="stat stat-pending">Pending: {stats.value.pending}</span>
          <span class="stat stat-approved">Approved: {stats.value.approved}</span>
          <span class="stat stat-rejected">Rejected: {stats.value.rejected}</span>
          <span class="stat">Annotations: {stats.value.total_annotations}</span>
          {stats.value.class_counts.map((c) => (
            <span class="stat stat-class" key={c.class_label}>
              {c.class_label}: {c.count}
            </span>
          ))}
        </div>
      )}

      <div class="training-filters">
        {(["all", "pending", "approved", "rejected"] as StatusFilter[]).map(
          (s) => (
            <button
              key={s}
              class={`filter-btn ${filter.value === s ? "active" : ""}`}
              onClick={() => {
                filter.value = s;
                offset.value = 0;
              }}
            >
              {s}
            </button>
          ),
        )}
      </div>

      {showCleanup.value && stats.value && (
        <CleanupModal
          rejectedCount={stats.value.rejected}
          onConfirm={async (deleteRemote) => {
            showCleanup.value = false;
            try {
              const result = await cleanupRejected(deleteRemote);
              const msg = [
                `Deleted ${result.deleted} frames from local DB.`,
                deleteRemote
                  ? `${result.remote_deleted} files removed from RDK X5.`
                  : "Remote files kept.",
                result.remote_errors.length > 0
                  ? `Errors: ${result.remote_errors.join("; ")}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n");
              alert(msg);
              await loadFrames();
              await loadStats();
            } catch (e) {
              alert(`Cleanup failed: ${e}`);
            }
          }}
          onCancel={() => (showCleanup.value = false)}
        />
      )}

      {loading.value ? (
        <p class="loading-msg">Loading...</p>
      ) : frames.value.length === 0 ? (
        <p class="empty-msg">
          No frames found. Click "Sync from RDK X5" to import.
        </p>
      ) : (
        <>
          <div class="frame-grid">
            {frames.value.map((frame) => (
              <FrameCard
                key={frame.id}
                frame={frame}
                onClick={() => handleFrameClick(frame)}
                onApprove={() => handleStatusChange(frame, "approved")}
                onReject={() => handleStatusChange(frame, "rejected")}
              />
            ))}
          </div>
          {pageCount.value > 1 && (
            <div class="training-pagination">
              <button
                disabled={offset.value === 0}
                onClick={() => (offset.value = Math.max(0, offset.value - limit))}
              >
                Prev
              </button>
              <span>
                {currentPage.value} / {pageCount.value}
              </span>
              <button
                disabled={offset.value + limit >= total.value}
                onClick={() => (offset.value = offset.value + limit)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const THUMB_CACHE_KEY = (id: number) => `thumb_v1_${id}`;

function FrameCard({
  frame,
  onClick,
  onApprove,
  onReject,
}: {
  frame: TrainingFrame;
  onClick: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const statusClass =
    frame.status === "approved"
      ? "card-approved"
      : frame.status === "rejected"
        ? "card-rejected"
        : "";

  // Check localStorage cache first, then lazy-fetch when visible
  const imgSrc = useSignal<string | null>(
    localStorage.getItem(THUMB_CACHE_KEY(frame.id)),
  );
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (imgSrc.value) return; // already cached
    const el = thumbRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        observer.disconnect();
        fetch(`/api/training/frames/${frame.id}/image`)
          .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
          .then(
            (blob) =>
              new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              }),
          )
          .then((dataUrl) => {
            try {
              localStorage.setItem(THUMB_CACHE_KEY(frame.id), dataUrl);
            } catch {
              // localStorage quota exceeded — display without caching
            }
            imgSrc.value = dataUrl;
          })
          .catch(() => {
            imgSrc.value = "error";
          });
      },
      { rootMargin: "120px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [frame.id]);

  return (
    <div class={`frame-card ${statusClass}`}>
      <div class="frame-thumb" ref={thumbRef} onClick={onClick}>
        {imgSrc.value && imgSrc.value !== "error" ? (
          <img src={imgSrc.value} alt={frame.filename} />
        ) : imgSrc.value === "error" ? (
          <div class="thumb-placeholder thumb-error">!</div>
        ) : (
          <div class="thumb-placeholder" />
        )}
        {frame.annotation_count > 0 && (
          <span class="ann-badge">{frame.annotation_count}</span>
        )}
      </div>
      <div class="frame-info">
        <span class="frame-name" title={frame.filename}>
          {frame.filename.replace(/_\d+x\d+\.nv12$/, "")}
        </span>
        <div class="frame-actions">
          <button
            class="btn-approve"
            onClick={(e) => {
              e.stopPropagation();
              onApprove();
            }}
            title="Approve"
          >
            O
          </button>
          <button
            class="btn-reject"
            onClick={(e) => {
              e.stopPropagation();
              onReject();
            }}
            title="Reject"
          >
            X
          </button>
        </div>
      </div>
    </div>
  );
}

function CleanupModal({
  rejectedCount,
  onConfirm,
  onCancel,
}: {
  rejectedCount: number;
  onConfirm: (deleteRemote: boolean) => void;
  onCancel: () => void;
}) {
  const deleteRemote = useSignal(true);

  return (
    <div class="modal-overlay" onClick={onCancel}>
      <div class="modal-box" onClick={(e) => e.stopPropagation()}>
        <h3 class="modal-title">Cleanup Rejected Frames</h3>
        <p class="modal-body">
          <strong>{rejectedCount} rejected frames</strong> will be permanently
          deleted from the local database and cache.
        </p>
        <label class="modal-checkbox">
          <input
            type="checkbox"
            checked={deleteRemote.value}
            onChange={(e) =>
              (deleteRemote.value = (e.target as HTMLInputElement).checked)
            }
          />
          Also delete original NV12 files from RDK X5
        </label>
        <p class="modal-warning">This action cannot be undone.</p>
        <div class="modal-actions">
          <button class="btn-modal-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            class="btn-modal-delete"
            onClick={() => onConfirm(deleteRemote.value)}
          >
            Delete {rejectedCount} frames
          </button>
        </div>
      </div>
    </div>
  );
}
