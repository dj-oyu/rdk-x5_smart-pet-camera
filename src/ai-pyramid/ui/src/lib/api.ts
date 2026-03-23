export type EventStatus = "valid" | "invalid" | "pending";
export type StatusFilter = "all" | "valid" | "invalid" | "pending";

export type EventSummary = {
  id: number;
  source_filename: string;
  observed_at: string;
  summary: string | null;
  status: EventStatus;
  pet_id: string | null;
  behavior: string | null;
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
};

export const DEFAULT_QUERY: EventQuery = {
  status: "all",
  petId: "",
  search: "",
  behavior: "",
  limit: 0,
  offset: 0,
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
};

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
  const url = search ? `/app?${search}` : "/app";
  window.history.replaceState({}, "", url);
}
