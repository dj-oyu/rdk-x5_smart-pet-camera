import { signal, computed, effect, action, createModel } from "@preact/signals";
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
import { createCancellable, isCancelled } from "./cancellable";

const STANDALONE_LIMIT = 24;
export const embed = isEmbedded();

const initQuery = (() => {
  const q = readQueryFromLocation();
  if (!embed.embedded && q.limit === 0) return { ...q, limit: STANDALONE_LIMIT };
  return q;
})();

export const AppStore = createModel(() => {
  const query = signal<EventQuery>(initQuery);
  const events = signal<EventSummary[]>([]);
  const total = signal(0);
  const stats = signal<ActivityStats | null>(null);
  const petNames = signal<PetNames>({});
  const behaviors = signal<string[]>([]);
  const loading = signal(true);
  const error = signal<string | null>(null);
  const selectedEvent = signal<EventSummary | null>(null);
  const initialPanel = signal<number | null>(null);

  const subtitle = computed(() =>
    query.value.petId ? `${total.value} events for ${query.value.petId}` : `${total.value} events`
  );

  const fetchCancel = createCancellable();

  const loadData = action(async () => {
    const { signal: sig } = fetchCancel.reset();
    loading.value = true;
    error.value = null;
    try {
      const [eventResult, statsResult] = await Promise.all([
        fetchEvents(query.value, sig),
        fetchStats(sig),
      ]);
      events.value = eventResult.events;
      total.value = eventResult.total;
      stats.value = statsResult;
    } catch (e) {
      if (isCancelled(e)) return;
      error.value = e instanceof Error ? e.message : "Failed to load data";
    } finally {
      loading.value = false;
    }
  });

  const updateQuery = action((patch: Partial<EventQuery>) => {
    query.value = {
      ...query.value,
      ...patch,
      offset: "offset" in patch ? (patch.offset ?? 0) : 0,
    };
  });

  const toggleYoloClass = action((cls: string) => {
    const current = query.value;
    const classes = current.yoloClasses.includes(cls)
      ? current.yoloClasses.filter((c) => c !== cls)
      : [...current.yoloClasses, cls];
    query.value = { ...current, yoloClasses: classes, offset: 0 };
  });

  const openModal = action((event: EventSummary) => {
    console.log("[openModal] called with:", event.id, "current selectedEvent:", selectedEvent.peek()?.id ?? "null");
    selectedEvent.value = event;
    initialPanel.value = null;
    console.log("[openModal] after set:", selectedEvent.peek()?.id ?? "null");
    history.pushState(null, "", `/app/photo/${event.id}${location.search}`);
  });

  const closeModal = action(() => {
    selectedEvent.value = null;
    initialPanel.value = null;
    history.pushState(null, "", `/app${location.search}`);
  });

  // Effect: query → fetch + URL sync
  effect(() => {
    writeQueryToLocation(query.value);
    void loadData();
  });

  // Popstate
  const onPop = () => {
    const { photoId } = parseDeepLink(location.pathname);
    if (photoId && !selectedEvent.peek()) {
      fetchEventById(photoId).then(ev => { if (ev) selectedEvent.value = ev; });
    } else if (!photoId && selectedEvent.peek()) {
      selectedEvent.value = null;
    }
  };
  window.addEventListener("popstate", onPop);
  // Cleanup on dispose
  effect(() => () => { window.removeEventListener("popstate", onPop); fetchCancel.abort(); });

  // Init: petNames, behaviors, deep link
  fetchPetNames().then(n => { petNames.value = n; });
  if (!embed.embedded) fetchBehaviors().then(b => { behaviors.value = b; });

  const { photoId, panelIndex } = parseDeepLink(location.pathname);
  if (photoId) {
    if (panelIndex != null) initialPanel.value = panelIndex;
    fetchEventById(photoId).then(ev => { if (ev) selectedEvent.value = ev; });
  }

  // SSE
  startSSE({ onRefresh: () => void loadData() });

  return {
    query, events, total, stats, petNames, behaviors,
    loading, error, selectedEvent, initialPanel, subtitle,
    loadData, updateQuery, toggleYoloClass, openModal, closeModal,
  };
});
