// Training annotation API client

export type TrainingFrame = {
  id: number;
  filename: string;
  width: number;
  height: number;
  captured_at: string | null;
  status: "pending" | "approved" | "rejected";
  source: string;
  annotation_count: number;
  created_at: string;
  is_bg_ref: boolean;
  bg_score: number | null;
};

export type TrainingAnnotation = {
  id: number;
  frame_id: number;
  class_label: string;
  x_center: number;
  y_center: number;
  width: number;
  height: number;
  created_at: string;
};

export type AnnotationInput = {
  class_label: string;
  x_center: number;
  y_center: number;
  width: number;
  height: number;
};

export type TrainingStats = {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  total_annotations: number;
  class_counts: { class_label: string; count: number }[];
};

export async function syncFrames(): Promise<{ synced: number; total_remote: number }> {
  const r = await fetch("/api/training/sync", { method: "POST" });
  if (!r.ok) throw new Error(`sync failed: ${r.status}`);
  return r.json();
}

export async function fetchFrames(
  status?: string,
  limit = 50,
  offset = 0,
): Promise<{ frames: TrainingFrame[]; total: number }> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  const r = await fetch(`/api/training/frames?${params}`);
  if (!r.ok) throw new Error(`fetch frames failed: ${r.status}`);
  return r.json();
}

export async function fetchFrame(
  id: number,
): Promise<{ frame: TrainingFrame; annotations: TrainingAnnotation[] }> {
  const r = await fetch(`/api/training/frames/${id}`);
  if (!r.ok) throw new Error(`fetch frame failed: ${r.status}`);
  return r.json();
}

export function frameImageUrl(id: number): string {
  return `/api/training/frames/${id}/image`;
}

export async function updateFrameStatus(
  id: number,
  status: "pending" | "approved" | "rejected",
): Promise<void> {
  const r = await fetch(`/api/training/frames/${id}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!r.ok) throw new Error(`update status failed: ${r.status}`);
}

export async function saveAnnotations(
  frameId: number,
  annotations: AnnotationInput[],
): Promise<void> {
  const r = await fetch(`/api/training/frames/${frameId}/annotations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(annotations),
  });
  if (!r.ok) throw new Error(`save annotations failed: ${r.status}`);
}

export async function fetchTrainingStats(): Promise<TrainingStats> {
  const r = await fetch("/api/training/stats");
  if (!r.ok) throw new Error(`fetch stats failed: ${r.status}`);
  return r.json();
}

export async function cleanupRejected(deleteRemote: boolean): Promise<{
  deleted: number;
  remote_deleted: number;
  remote_errors: string[];
}> {
  const r = await fetch("/api/training/cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete_remote: deleteRemote }),
  });
  if (!r.ok) throw new Error(`cleanup failed: ${r.status}`);
  return r.json();
}

// ── Background model API ──────────────────────────────────────────

export type BgStatus = {
  model_exists: boolean;
  model_frame_count: number;
  model_width: number;
  model_height: number;
  bg_ref_count: number;
  stale: boolean;
  min_refs_required: number;
};

export async function setBgRef(id: number, isBgRef: boolean): Promise<void> {
  const r = await fetch(`/api/training/frames/${id}/bg_ref`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_bg_ref: isBgRef }),
  });
  if (!r.ok) throw new Error(`set bg_ref failed: ${r.status}`);
}

export async function fetchBgStatus(): Promise<BgStatus> {
  const r = await fetch("/api/training/bg/status");
  if (!r.ok) throw new Error(`bg status failed: ${r.status}`);
  return r.json();
}

export async function buildBgModel(): Promise<{
  frame_count: number;
  width: number;
  height: number;
  fetched_from_remote: number;
}> {
  const r = await fetch("/api/training/bg/build", { method: "POST" });
  if (!r.ok) {
    const msg = await r.text().catch(() => String(r.status));
    throw new Error(msg);
  }
  return r.json();
}

export async function scorePendingFrames(): Promise<{
  scored: number;
  skipped_not_cached: number;
}> {
  const r = await fetch("/api/training/bg/score", { method: "POST" });
  if (!r.ok) {
    const msg = await r.text().catch(() => String(r.status));
    throw new Error(msg);
  }
  return r.json();
}

export async function bulkRejectByScore(threshold: number): Promise<{ rejected: number }> {
  const r = await fetch("/api/training/bg/reject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threshold }),
  });
  if (!r.ok) throw new Error(`bulk reject failed: ${r.status}`);
  return r.json();
}
