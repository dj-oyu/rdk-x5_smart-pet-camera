import { useEffect, useState } from "preact/hooks";
import { EventDetail } from "./components/event-detail";
import { EventGrid } from "./components/event-grid";
import { FilterBar } from "./components/filter-bar";
import { StatsStrip } from "./components/stats-strip";
import {
  fetchEvents,
  fetchPetNames,
  fetchStats,
  isEmbedded,
  photoUrl,
  readQueryFromLocation,
  writeQueryToLocation,
  type ActivityStats,
  type EventQuery,
  type EventSummary,
  type PetNames,
  type StatusFilter
} from "./lib/api";

export function App() {
  const [query, setQuery] = useState<EventQuery>(() => readQueryFromLocation());
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<EventSummary | null>(null);
  const [petNames, setPetNames] = useState<PetNames>({});

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
        if (cancelled) {
          return;
        }
        setEvents(eventResult.events);
        setTotal(eventResult.total);
        setStats(statsResult);
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        const message = loadError instanceof Error ? loadError.message : "Failed to load data";
        setError(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [query, refreshTick]);

  useEffect(() => {
    fetchPetNames().then(setPetNames);
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("event", (message) => {
      setRefreshTick((current) => current + 1);
    });
    return () => source.close();
  }, []);

  const subtitle = query.petId
    ? `${total} events for ${query.petId}`
    : `${total} events in the current stream`;

  function handleStatusChange(status: StatusFilter) {
    setQuery((current) => ({ ...current, status }));
  }

  function handlePetChange(petId: string) {
    setQuery((current) => ({ ...current, petId }));
  }

  const embed = isEmbedded();

  return (
    <main class="app-shell compact-shell" data-embed={embed.embedded ? embed.host : undefined}>
      <div class="compact-bar">
        <strong>Recent Events</strong>
        <span>{subtitle}</span>
      </div>
      <EventGrid
        events={events}
        loading={loading}
        error={error}
        onOpenEvent={(event) => setSelectedEvent(event)}
      />
      {selectedEvent && (
        <EventDetail
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
      <section class="secondary-stack">
        <FilterBar query={query} petNames={petNames} onStatusChange={handleStatusChange} onPetChange={handlePetChange} />
        <StatsStrip stats={stats} />
      </section>
    </main>
  );
}
