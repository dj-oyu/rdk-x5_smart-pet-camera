import { useEffect, useState } from "preact/hooks";
import { BackfillButton } from "./components/backfill-button";
import { DailySummary } from "./components/daily-summary";
import { EventDetail } from "./components/event-detail";
import { EventGrid } from "./components/event-grid";
import { FilterBar } from "./components/filter-bar";
import { Pagination } from "./components/pagination";
import { SearchBar } from "./components/search-bar";
import { StatsStrip } from "./components/stats-strip";
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
  type StatusFilter
} from "./lib/api";

const STANDALONE_LIMIT = 24;

export function App() {
  const embed = isEmbedded();
  const [query, setQuery] = useState<EventQuery>(() => {
    const q = readQueryFromLocation();
    if (!embed.embedded && q.limit === 0) {
      return { ...q, limit: STANDALONE_LIMIT };
    }
    return q;
  });
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<EventSummary | null>(null);
  const [initialPanel, setInitialPanel] = useState<number | null>(null);
  const [petNames, setPetNames] = useState<PetNames>({});
  const [behaviors, setBehaviors] = useState<string[]>([]);

  useEffect(() => {
    writeQueryToLocation(query);
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [eventResult, statsResult] = await Promise.all([
          fetchEvents(query),
          fetchStats()
        ]);
        if (cancelled) return;
        setEvents(eventResult.events);
        setTotal(eventResult.total);
        setStats(statsResult);
      } catch (loadError) {
        if (cancelled) return;
        const message = loadError instanceof Error ? loadError.message : "Failed to load data";
        setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [query, refreshTick]);

  useEffect(() => {
    fetchPetNames().then(setPetNames);
    if (!embed.embedded) {
      fetchBehaviors().then(setBehaviors);
    }
    // Deep link: open photo if URL has /app/photo/{id}[/panel/{n}]
    const { photoId, panelIndex } = parseDeepLink(location.pathname);
    if (photoId) {
      if (panelIndex != null) setInitialPanel(panelIndex);
      fetchEventById(photoId).then(ev => {
        if (ev) setSelectedEvent(ev);
      });
    }
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("event", () => {
      setRefreshTick((current) => current + 1);
    });
    return () => source.close();
  }, []);

  function openModal(event: EventSummary) {
    setSelectedEvent(event);
    setInitialPanel(null);
    history.pushState(null, "", `/app/photo/${event.id}${location.search}`);
  }

  function closeModal() {
    setSelectedEvent(null);
    setInitialPanel(null);
    history.pushState(null, "", `/app${location.search}`);
  }

  // Back/forward button: sync modal state with URL
  useEffect(() => {
    function onPop() {
      const { photoId } = parseDeepLink(location.pathname);
      if (photoId && !selectedEvent) {
        fetchEventById(photoId).then(ev => { if (ev) setSelectedEvent(ev); });
      } else if (!photoId && selectedEvent) {
        setSelectedEvent(null);
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [selectedEvent]);

  function updateQuery(patch: Partial<EventQuery>) {
    setQuery((current) => ({
      ...current,
      ...patch,
      offset: "offset" in patch ? (patch.offset ?? 0) : 0,
    }));
  }

  function toggleYoloClass(cls: string) {
    setQuery((current) => {
      const classes = current.yoloClasses.includes(cls)
        ? current.yoloClasses.filter((c) => c !== cls)
        : [...current.yoloClasses, cls];
      return { ...current, yoloClasses: classes, offset: 0 };
    });
  }

  const subtitle = query.petId
    ? `${total} events for ${query.petId}`
    : `${total} events`;

  if (embed.embedded) {
    return (
      <main class="app-shell compact-shell" data-embed={embed.host ?? undefined}>
        <div class="compact-bar">
          <strong>Recent Events</strong>
          <span>{subtitle}</span>
        </div>
        <EventGrid
          events={events}
          loading={loading}
          error={error}
          petNames={petNames}
          onOpenEvent={openModal}
        />
        {selectedEvent && (
          <EventDetail
            event={selectedEvent}
            petNames={petNames}
            onClose={closeModal}
            onUpdated={() => setRefreshTick((c) => c + 1)}
            initialPanel={initialPanel}
          />
        )}
        <section class="secondary-stack">
          <FilterBar
            query={query}
            petNames={petNames}
            onStatusChange={(status) => updateQuery({ status })}
            onPetChange={(petId) => updateQuery({ petId })}
          />
          <StatsStrip stats={stats} />
        </section>
      </main>
    );
  }

  return (
    <main class="app-shell standalone-shell">
      <header class="standalone-header">
        <h1 class="standalone-title">Pet Album</h1>
        <SearchBar
          value={query.search}
          onChange={(search) => updateQuery({ search })}
        />
      </header>
      <div class="standalone-body">
        <aside class="standalone-sidebar">
          <FilterBar
            query={query}
            petNames={petNames}
            behaviors={behaviors}
            onStatusChange={(status) => updateQuery({ status })}
            onPetChange={(petId) => updateQuery({ petId })}
            onBehaviorChange={(behavior) => updateQuery({ behavior })}
            onYoloClassToggle={toggleYoloClass}
          />
          <DailySummary />
          <BackfillButton />
        </aside>
        <div class="standalone-main">
          <StatsStrip stats={stats} />
          <EventGrid
            events={events}
            loading={loading}
            error={error}
            petNames={petNames}
            onOpenEvent={openModal}
          />
          <Pagination
            total={total}
            limit={query.limit}
            offset={query.offset}
            onPageChange={(offset) => updateQuery({ offset })}
          />
        </div>
      </div>
      {selectedEvent && (
        <EventDetail
          event={selectedEvent}
          petNames={petNames}
          onClose={closeModal}
          onUpdated={() => setRefreshTick((c) => c + 1)}
        />
      )}
    </main>
  );
}
