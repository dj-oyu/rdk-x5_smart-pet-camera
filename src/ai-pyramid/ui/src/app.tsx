import { useEffect, useState } from "preact/hooks";
import { DailySummary } from "./components/daily-summary";
import { EventDetail } from "./components/event-detail";
import { EventGrid } from "./components/event-grid";
import { FilterBar } from "./components/filter-bar";
import { Pagination } from "./components/pagination";
import { SearchBar } from "./components/search-bar";
import { StatsStrip } from "./components/stats-strip";
import {
  fetchBehaviors,
  fetchEvents,
  fetchPetNames,
  fetchStats,
  isEmbedded,
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
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("event", () => {
      setRefreshTick((current) => current + 1);
    });
    return () => source.close();
  }, []);

  function updateQuery(patch: Partial<EventQuery>) {
    setQuery((current) => ({
      ...current,
      ...patch,
      offset: "offset" in patch ? (patch.offset ?? 0) : 0,
    }));
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
          onOpenEvent={(event) => setSelectedEvent(event)}
        />
        {selectedEvent && (
          <EventDetail
            event={selectedEvent}
            petNames={petNames}
            onClose={() => setSelectedEvent(null)}
            onUpdated={() => setRefreshTick((c) => c + 1)}
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
          />
          <DailySummary />
        </aside>
        <div class="standalone-main">
          <StatsStrip stats={stats} />
          <EventGrid
            events={events}
            loading={loading}
            error={error}
            petNames={petNames}
            onOpenEvent={(event) => setSelectedEvent(event)}
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
          onClose={() => setSelectedEvent(null)}
          onUpdated={() => setRefreshTick((c) => c + 1)}
        />
      )}
    </main>
  );
}
