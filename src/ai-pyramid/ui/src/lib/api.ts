export type EventStatus = "valid" | "invalid" | "pending";
export type StatusFilter = "all" | "valid" | "invalid" | "pending";

export type BboxSummary = {
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
};

export type EventSummary = {
  id: number;
  source_filename: string;
  observed_at: string;
  summary: string | null;
  status: EventStatus;
  pet_id: string | null;
  behavior: string | null;
  bboxes?: BboxSummary[];
};

export type EventListResponse = {
  events: EventSummary[];
  total: number;
};

export type ActivityStats = {
  total_events: number;
  confirmed_events: number;
  rejected_events: number;
  pending_events: number;
};

export type EventQuery = {
  status: StatusFilter;
  petId: string;
  search: string;
  behavior: string;
  limit: number;
  offset: number;
  yoloClasses: string[];
};

export const DEFAULT_QUERY: EventQuery = {
  status: "all",
  petId: "",
  search: "",
  behavior: "",
  limit: 0,
  offset: 0,
  yoloClasses: [],
};

function buildParams(query: EventQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.status !== "all") {
    params.set("is_valid", query.status === "valid" ? "true" : query.status === "invalid" ? "false" : "pending");
  }
  if (query.petId) {
    params.set("pet_id", query.petId);
  }
  if (query.search) {
    params.set("search", query.search);
  }
  if (query.behavior) {
    params.set("behavior", query.behavior);
  }
  if (query.limit > 0) {
    params.set("limit", String(query.limit));
  }
  if (query.offset > 0) {
    params.set("offset", String(query.offset));
  }
  if (query.yoloClasses.length > 0) {
    params.set("yolo_class", query.yoloClasses.join(","));
  }
  return params;
}

export async function fetchEvents(query: EventQuery): Promise<EventListResponse> {
  const params = buildParams(query);
  const response = await fetch(`/api/photos?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`failed to load events: ${response.status}`);
  }
  return response.json();
}

export async function fetchStats(): Promise<ActivityStats> {
  const response = await fetch("/api/stats");
  if (!response.ok) {
    throw new Error(`failed to load stats: ${response.status}`);
  }
  return response.json();
}

export function photoUrl(sourceFilename: string): string {
  return `/api/photos/${encodeURIComponent(sourceFilename)}`;
}

export async function fetchEventById(id: number): Promise<EventSummary | null> {
  const response = await fetch(`/api/event/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`failed to fetch event: ${response.status}`);
  return response.json();
}

export type DeepLink = {
  photoId: number | null;
  panelIndex: number | null;
};

export function parseDeepLink(pathname: string): DeepLink {
  const m = pathname.match(/^\/app\/photo\/(\d+)(?:\/panel\/([0-3]))?$/);
  if (!m) return { photoId: null, panelIndex: null };
  return {
    photoId: parseInt(m[1], 10),
    panelIndex: m[2] != null ? parseInt(m[2], 10) : null,
  };
}

export type Detection = {
  id: number;
  photo_id: number;
  panel_index: number | null;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  yolo_class: string | null;
  pet_class: string | null;
  pet_id_override: string | null;
  confidence: number | null;
  detected_at: string;
  det_level: number;
  model: string | null;
};

export type PartialDetection = {
  type: "detection-partial";
  filename: string;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  yolo_class: string;
  confidence: number;
};

export type DetectionReady = {
  type: "detection-ready";
  filename: string;
  count: number;
};

export async function detectNow(filename: string): Promise<{ ok: boolean; detections?: number; error?: string }> {
  const response = await fetch(`/api/detect-now/${encodeURIComponent(filename)}`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { ok: false, error: body.error ?? `status ${response.status}` };
  }
  return response.json();
}

export async function fetchDetections(photoId: number): Promise<Detection[]> {
  const response = await fetch(`/api/detections/${photoId}`);
  if (!response.ok) {
    throw new Error(`failed to load detections: ${response.status}`);
  }
  return response.json();
}

export async function updateDetectionOverride(detectionId: number, petIdOverride: string): Promise<void> {
  const response = await fetch(`/api/detections/${detectionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pet_id_override: petIdOverride }),
  });
  if (!response.ok) {
    throw new Error(`failed to update detection: ${response.status}`);
  }
}

export type PetNames = Record<string, string>;

export async function fetchPetNames(): Promise<PetNames> {
  const response = await fetch("/api/pet-names");
  if (!response.ok) {
    return {};
  }
  return response.json();
}

export async function fetchBehaviors(): Promise<string[]> {
  const response = await fetch("/api/behaviors");
  if (!response.ok) {
    return [];
  }
  return response.json();
}

export type DailySummaryResponse = {
  date: string;
  summary: string;
  photo_count: number;
};

export async function fetchDailySummary(date?: string): Promise<DailySummaryResponse> {
  const response = await fetch("/api/daily-summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: date ?? null }),
  });
  if (!response.ok) {
    throw new Error(`failed to load daily summary: ${response.status}`);
  }
  return response.json();
}

export async function startBackfill(): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("/api/backfill", { method: "POST" });
  if (response.status === 409) {
    return { ok: false, error: "already running" };
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { ok: false, error: body.error ?? `status ${response.status}` };
  }
  return { ok: true };
}

export async function fetchBackfillStatus(): Promise<{ running: boolean }> {
  const response = await fetch("/api/backfill/status");
  if (!response.ok) {
    return { running: false };
  }
  return response.json();
}

export async function updatePhotoPetId(sourceFilename: string, petId: string): Promise<void> {
  await updatePhotoFields(sourceFilename, { pet_id: petId });
}

export async function updatePhotoFields(
  sourceFilename: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`/api/photos/${encodeURIComponent(sourceFilename)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!response.ok) {
    throw new Error(`failed to update photo: ${response.status}`);
  }
}

export function readQueryFromLocation(): EventQuery {
  const params = new URLSearchParams(window.location.search);
  const rawStatus = params.get("is_valid");
  const status: StatusFilter = rawStatus === "true"
    ? "valid"
    : rawStatus === "false"
      ? "invalid"
      : rawStatus === "pending"
        ? "pending"
        : "all";

  return {
    status,
    petId: params.get("pet_id") ?? "",
    search: params.get("search") ?? "",
    behavior: params.get("behavior") ?? "",
    limit: Number(params.get("limit")) || 0,
    offset: Number(params.get("offset")) || 0,
    yoloClasses: (params.get("yolo_class") ?? "").split(",").filter(Boolean),
  };
}

export function isEmbedded(): { embedded: boolean; host: string | null } {
  const params = new URLSearchParams(window.location.search);
  const embed = params.get("embed");
  return { embedded: embed !== null, host: embed };
}

export function writeQueryToLocation(query: EventQuery): void {
  const params = buildParams(query);
  const embed = new URLSearchParams(window.location.search).get("embed");
  if (embed) {
    params.set("embed", embed);
  }
  const search = params.toString();
  // Preserve deep link path (e.g. /app/photo/42/panel/1) — only rewrite if on /app
  const basePath = window.location.pathname.startsWith("/app/photo/")
    ? window.location.pathname
    : "/app";
  const url = search ? `${basePath}?${search}` : basePath;
  window.history.replaceState({}, "", url);
}
