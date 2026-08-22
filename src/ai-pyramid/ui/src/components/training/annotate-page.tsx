import { useSignal, useComputed } from "@preact/signals";
import { useEffect } from "preact/hooks";
import {
  syncFrames,
  fetchFrames,
  fetchTrainingStats,
  updateFrameStatus,
  cleanupRejected,
  setBgRef,
  fetchBgStatus,
  type TrainingFrame,
  type TrainingStats,
  type BgStatus,
} from "../../lib/training-api";
import { AnnotateCanvas } from "./annotate-canvas";
import { BgModelPanel, CleanupModal } from "./training-dialogs";
import { TrainingFrameCard } from "./training-frame-card";

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
              <TrainingFrameCard
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
