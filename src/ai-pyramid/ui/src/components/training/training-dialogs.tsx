import { useSignal } from "@preact/signals";
import {
  buildBgModel,
  bulkRejectByScore,
  scorePendingFrames,
  type BgStatus,
} from "../../lib/training-api";

export function BgModelPanel({
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
        <button class="btn-close" onClick={onClose}>✕</button>
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
        Mark empty frames with ◆, then build the model. Score pending frames,
        then bulk-reject low-scoring ones.
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
            onInput={(e) =>
              (threshold.value = Number((e.target as HTMLInputElement).value))
            }
            class="bg-threshold-slider"
          />
          <span class="bg-threshold-val">{threshold.value}%</span>
        </label>
        <button class="btn-bg-reject" onClick={handleReject} disabled={rejecting.value || !canScore}>
          {rejecting.value ? "Rejecting..." : "3. Bulk Reject"}
        </button>
      </div>
      {lastResult.value && <p class="bg-result">{lastResult.value}</p>}
    </div>
  );
}

export function CleanupModal({
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
          Also delete original frame files from RDK X5
        </label>
        <p class="modal-warning">This action cannot be undone.</p>
        <div class="modal-actions">
          <button class="btn-modal-cancel" onClick={onCancel}>Cancel</button>
          <button class="btn-modal-delete" onClick={() => onConfirm(deleteRemote.value)}>
            Delete {rejectedCount} frames
          </button>
        </div>
      </div>
    </div>
  );
}
