import { signal, computed, effect } from "@preact/signals";
import {
  fetchBehaviors,
  fetchEventById,
  fetchEvents,
  fetchPetNames,
  fetchStats,
  isEmbedded,
  parseDeepLink,
  readQueryFromLocation,
  writeQueryToLocation,
  type ActivityStats,
  type EventQuery,
  type EventSummary,
  type PetNames,
} from "./api";
import { startSSE } from "./sse";

const STANDALONE_LIMIT = 24;

// --- Embed detection (static) ---
export const embed = isEmbedded();

// --- Global signals ---
const initQuery = (() => {
  const q = readQueryFromLocation();
  if (!embed.embedded && q.limit === 0) return { ...q, limit: STANDALONE_LIMIT };
  return q;
})();
export const query = signal<EventQuery>(initQuery);
export const events = signal<EventSummary[]>([]);
export const total = signal(0);
export const stats = signal<ActivityStats | null>(null);
export const petNames = signal<PetNames>({});
export const behaviors = signal<string[]>([]);
export const loading = signal(true);
export const error = signal<string | null>(null);
export const selectedEvent = signal<EventSummary | null>(null);
export const initialPanel = signal<number | null>(null);

// --- Computed ---
export const subtitle = computed(() => {
  const q = query.value;
  return q.petId ? `${total.value} events for ${q.petId}` : `${total.value} events`;
});

// --- Actions ---
let fetchController: AbortController | null = null;

async function loadData(): Promise<void> {
  fetchController?.abort();
  const ctrl = new AbortController();
  fetchController = ctrl;
  loading.value = true;
  error.value = null;
  try {
    const [eventResult, statsResult] = await Promise.all([
      fetchEvents(query.value),
      fetchStats(),
    ]);
    if (ctrl.signal.aborted) return;
    events.value = eventResult.events;
    total.value = eventResult.total;
    stats.value = statsResult;
  } catch (e) {
    if (ctrl.signal.aborted) return;
    error.value = e instanceof Error ? e.message : "Failed to load data";
  } finally {
    if (!ctrl.signal.aborted) loading.value = false;
  }
}

export function updateQuery(patch: Partial<EventQuery>): void {
  query.value = {
    ...query.value,
    ...patch,
    offset: "offset" in patch ? (patch.offset ?? 0) : 0,
  };
}

export function toggleYoloClass(cls: string): void {
  const current = query.value;
  const classes = current.yoloClasses.includes(cls)
    ? current.yoloClasses.filter((c) => c !== cls)
    : [...current.yoloClasses, cls];
  query.value = { ...current, yoloClasses: classes, offset: 0 };
}

export function openModal(event: EventSummary): void {
  selectedEvent.value = event;
  initialPanel.value = null;
  history.pushState(null, "", `/app/photo/${event.id}${location.search}`);
}

export function closeModal(): void {
  selectedEvent.value = null;
  initialPanel.value = null;
  history.pushState(null, "", `/app${location.search}`);
}

export function refresh(): void {
  void loadData();
}

// --- Effects ---
let queryEffectDisposer: (() => void) | null = null;
let popstateHandler: ((e: PopStateEvent) => void) | null = null;

export function initStore(): void {
  // Initial data fetch
  fetchPetNames().then((n) => { petNames.value = n; });
  if (!embed.embedded) {
    fetchBehaviors().then((b) => { behaviors.value = b; });
  }

  // Deep link
  const { photoId, panelIndex } = parseDeepLink(location.pathname);
  if (photoId) {
    if (panelIndex != null) initialPanel.value = panelIndex;
    fetchEventById(photoId).then((ev) => {
      if (ev) selectedEvent.value = ev;
    });
  }

  // SSE
  startSSE({ onRefresh: refresh });

  // Query → fetch + URL sync
  queryEffectDisposer = effect(() => {
    const q = query.value;
    writeQueryToLocation(q);
    void loadData();
  });

  // Popstate → sync modal
  popstateHandler = () => {
    const { photoId } = parseDeepLink(location.pathname);
    if (photoId && !selectedEvent.value) {
      fetchEventById(photoId).then((ev) => {
        if (ev) selectedEvent.value = ev;
      });
    } else if (!photoId && selectedEvent.value) {
      selectedEvent.value = null;
    }
  };
  window.addEventListener("popstate", popstateHandler);
}

export function disposeStore(): void {
  queryEffectDisposer?.();
  if (popstateHandler) window.removeEventListener("popstate", popstateHandler);
  fetchController?.abort();
}
