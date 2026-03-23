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
};

function buildParams(query: EventQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.status !== "all") {
    params.set("is_valid", query.status === "valid" ? "true" : query.status === "invalid" ? "false" : "pending");
  }
  if (query.petId) {
    params.set("pet_id", query.petId);
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
    petId: params.get("pet_id") ?? ""
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
