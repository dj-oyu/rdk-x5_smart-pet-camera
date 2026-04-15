import { useSignal, useComputed } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import {
  syncFrames,
  fetchFrames,
  fetchTrainingStats,
  updateFrameStatus,
  cleanupRejected,
  setBgRef,
  fetchBgStatus,
  buildBgModel,
  scorePendingFrames,
  bulkRejectByScore,
  type TrainingFrame,
  type TrainingStats,
  type BgStatus,
} from "../../lib/training-api";
import { AnnotateCanvas } from "./annotate-canvas";

type StatusFilter = "all" | "pending" | "approved" | "rejected";

export function AnnotatePage() {
  const frames = useSignal<TrainingFrame[]>([]);
  const total = useSignal(0);
  const stats = useSignal<TrainingStats | null>(null);
  const bgStatus = useSignal<BgStatus | null>(null);
  const loading = useSignal(false);
  const syncing = useSignal(false);
  const filter = useSignal<StatusFilter>("pending");
  const offset = useSignal(0);
  const selectedFrame = useSignal<TrainingFrame | null>(null);
  const showCleanup = useSignal(false);
  const showBgPanel = useSignal(false);
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

  const loadBgStatus = async () => {
    try {
      bgStatus.value = await fetchBgStatus();
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadFrames();
    loadStats();
    loadBgStatus();
  }, []);

  useEffect(() => {
    // Skip reload while in annotation view — navigation manages frames directly.
    if (selectedFrame.value) return;
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
      frames.value = frames.value.map((f) => (f.id === frame.id ? { ...f, status } : f));
      loadStats();
    } catch (e) {
      alert(`Failed: ${e}`);
    }
  };

  const handleToggleBgRef = async (frame: TrainingFrame) => {
    const newVal = !frame.is_bg_ref;
    try {
      await setBgRef(frame.id, newVal);
      frames.value = frames.value.map((f) =>
        f.id === frame.id ? { ...f, is_bg_ref: newVal } : f,
      );
      loadBgStatus();
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

  // Navigate to prev/next frame. Cross-page: fetch adjacent page without
  // triggering the filter/offset useEffect (guard below skips reload while
  // selectedFrame is set).
  const navigating = useSignal(false);

  const loadPageAndSelect = async (newOffset: number, pickLast: boolean) => {
    navigating.value = true;
    try {
      const statusParam = filter.value === "all" ? undefined : filter.value;
      const data = await fetchFrames(statusParam, limit, newOffset);
      offset.value = newOffset;
      frames.value = data.frames;
      total.value = data.total;
      if (data.frames.length > 0) {
        selectedFrame.value = pickLast
          ? data.frames[data.frames.length - 1]
          : data.frames[0];
      }
    } finally {
      navigating.value = false;
    }
  };

  const handleAnnotateNext = async () => {
    const idx = frames.value.findIndex((f) => f.id === selectedFrame.value?.id);
    if (idx < frames.value.length - 1) {
      selectedFrame.value = frames.value[idx + 1];
    } else if (offset.value + limit < total.value) {
      await loadPageAndSelect(offset.value + limit, false);
    }
  };

  const handleAnnotatePrev = async () => {
    const idx = frames.value.findIndex((f) => f.id === selectedFrame.value?.id);
    if (idx > 0) {
      selectedFrame.value = frames.value[idx - 1];
    } else if (offset.value > 0) {
      await loadPageAndSelect(offset.value - limit, true);
    }
  };

  const selectedFrameIdx = useComputed(() =>
    frames.value.findIndex((f) => f.id === selectedFrame.value?.id),
  );
  const frameIndex = useComputed(() => offset.value + selectedFrameIdx.value + 1);
  const hasNext = useComputed(
    () =>
      selectedFrameIdx.value < frames.value.length - 1 ||
      offset.value + limit < total.value,
  );
  const hasPrev = useComputed(
    () => selectedFrameIdx.value > 0 || offset.value > 0,
  );

  const pageCount = useComputed(() => Math.ceil(total.value / limit));
  const currentPage = useComputed(() => Math.floor(offset.value / limit) + 1);

  // If a frame is selected, show annotation canvas
  if (selectedFrame.value) {
    return (
      <AnnotateCanvas
        key={selectedFrame.value.id}
        frame={selectedFrame.value}
        onDone={handleAnnotateDone}
        onStatusChange={handleStatusChange}
        onNext={hasNext.value ? handleAnnotateNext : undefined}
        onPrev={hasPrev.value ? handleAnnotatePrev : undefined}
        frameIndex={frameIndex.value}
        frameTotal={total.value}
        navigating={navigating.value}
      />
    );
  }

  return (
    <div class="training-page">
      <header class="training-header">
        <h1>Training Dataset</h1>
        <button
          class={`btn-bg-model ${bgStatus.value?.stale ? "stale" : ""}`}
          onClick={() => (showBgPanel.value = !showBgPanel.value)}
          title="Background model for empty-frame detection"
        >
          BG Model
          {bgStatus.value && (
            <span class="bg-ref-count">
              ({bgStatus.value.bg_ref_count} refs
              {bgStatus.value.stale ? " !" : ""})
            </span>
          )}
        </button>
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
        <button class="btn-sync" onClick={handleSync} disabled={syncing.value}>
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

      {showBgPanel.value && bgStatus.value && (
        <BgModelPanel
          status={bgStatus.value}
          onClose={() => (showBgPanel.value = false)}
          onUpdated={() => {
            loadBgStatus();
            loadFrames();
            loadStats();
          }}
        />
      )}

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
                onToggleBgRef={() => handleToggleBgRef(frame)}
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
  onToggleBgRef,
}: {
  frame: TrainingFrame;
  onClick: () => void;
  onApprove: () => void;
  onReject: () => void;
  onToggleBgRef: () => void;
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
    <div class={`frame-card ${statusClass} ${frame.is_bg_ref ? "card-bg-ref" : ""}`}>
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
        {frame.bg_score !== null && frame.bg_score !== undefined && (
          <span
            class={`bg-score-badge ${frame.bg_score <= 5 ? "score-empty" : frame.bg_score >= 30 ? "score-occupied" : "score-mid"}`}
            title={`Background score: ${frame.bg_score.toFixed(1)}%`}
          >
            {frame.bg_score.toFixed(0)}%
          </span>
        )}
      </div>
      <div class="frame-info">
        <span class="frame-name" title={frame.filename}>
          {frame.filename.replace(/_\d+x\d+\.nv12$/, "")}
        </span>
        <div class="frame-actions">
          <button
            class={`btn-bg-ref ${frame.is_bg_ref ? "active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleBgRef();
            }}
            title={frame.is_bg_ref ? "Remove background reference" : "Mark as background reference"}
          >
            ◆
          </button>
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

function BgModelPanel({
  status,
  onClose,
  onUpdated,
}: {
  status: BgStatus;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const building = useSignal(false);
  const scoring = useSignal(false);
  const rejecting = useSignal(false);
  const threshold = useSignal(5);
  const lastResult = useSignal<string | null>(null);

  const handleBuild = async () => {
    building.value = true;
    lastResult.value = null;
    try {
      const r = await buildBgModel();
      lastResult.value = `Model built from ${r.frame_count} frames (${r.width}x${r.height})${r.fetched_from_remote > 0 ? `, fetched ${r.fetched_from_remote} from RDK X5` : ""}.`;
      onUpdated();
    } catch (e) {
      lastResult.value = `Build failed: ${e}`;
    } finally {
      building.value = false;
    }
  };

  const handleScore = async () => {
    scoring.value = true;
    lastResult.value = null;
    try {
      const r = await scorePendingFrames();
      lastResult.value = `Scored ${r.scored} frames. ${r.skipped_not_cached > 0 ? `${r.skipped_not_cached} skipped (not cached — view them first).` : ""}`;
      onUpdated();
    } catch (e) {
      lastResult.value = `Score failed: ${e}`;
    } finally {
      scoring.value = false;
    }
  };

  const handleReject = async () => {
    rejecting.value = true;
    lastResult.value = null;
    try {
      const r = await bulkRejectByScore(threshold.value);
      lastResult.value = `Rejected ${r.rejected} frames with score ≤ ${threshold.value}%.`;
      onUpdated();
    } catch (e) {
      lastResult.value = `Reject failed: ${e}`;
    } finally {
      rejecting.value = false;
    }
  };

  const canBuild = status.bg_ref_count >= status.min_refs_required;
  const canScore = status.model_exists;

  return (
    <div class="bg-panel">
      <div class="bg-panel-header">
        <h3>Background Model</h3>
        <button class="btn-close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div class="bg-panel-status">
        <div class="bg-stat">
          <span class="bg-stat-label">Reference frames</span>
          <span class="bg-stat-value">
            {status.bg_ref_count}
            {status.bg_ref_count < status.min_refs_required && (
              <span class="bg-warn"> (need {status.min_refs_required}+)</span>
            )}
          </span>
        </div>
        <div class="bg-stat">
          <span class="bg-stat-label">Model</span>
          <span class="bg-stat-value">
            {status.model_exists
              ? `${status.model_frame_count} frames, ${status.model_width}x${status.model_height}${status.stale ? " (stale)" : ""}`
              : "not built"}
          </span>
        </div>
      </div>

      <p class="bg-panel-help">
        Mark empty frames with ◆, then build the model. Score pending frames, then bulk-reject
        low-scoring ones.
      </p>

      <div class="bg-panel-actions">
        <button class="btn-bg-build" onClick={handleBuild} disabled={building.value || !canBuild}>
          {building.value ? "Building..." : "1. Build Model"}
        </button>
        <button class="btn-bg-score" onClick={handleScore} disabled={scoring.value || !canScore}>
          {scoring.value ? "Scoring..." : "2. Score Pending"}
        </button>
      </div>

      <div class="bg-panel-reject">
        <label class="bg-threshold-label">
          Reject if score ≤
          <input
            type="range"
            min={1}
            max={20}
            value={threshold.value}
            onInput={(e) => (threshold.value = Number((e.target as HTMLInputElement).value))}
            class="bg-threshold-slider"
          />
          <span class="bg-threshold-val">{threshold.value}%</span>
        </label>
        <button
          class="btn-bg-reject"
          onClick={handleReject}
          disabled={rejecting.value || !canScore}
        >
          {rejecting.value ? "Rejecting..." : "3. Bulk Reject"}
        </button>
      </div>

      {lastResult.value && <p class="bg-result">{lastResult.value}</p>}
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
