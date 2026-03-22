import { useEffect, useState } from "preact/hooks";
import { EventGrid } from "./components/event-grid";
import { FilterBar } from "./components/filter-bar";
import { StatsStrip } from "./components/stats-strip";
import {
  fetchEvents,
  fetchStats,
  readQueryFromLocation,
  writeQueryToLocation,
  type ActivityStats,
  type EventQuery,
  type EventSummary,
  type StatusFilter
} from "./lib/api";

export function App() {
  const [query, setQuery] = useState<EventQuery>(() => readQueryFromLocation());
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  }, [query]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("event", () => {
      setQuery((current) => ({ ...current }));
    });
    source.onerror = () => {
      source.close();
    };
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

  return (
    <main class="app-shell">
      <header class="hero">
        <div>
          <p class="eyebrow">Smart Pet Camera</p>
          <h1>Event feed, not just a photo roll.</h1>
          <p class="hero-copy">
            The backend already models observations and activity. This UI reads that event stream directly.
          </p>
        </div>
        <div class="hero-aside">
          <span>Live status</span>
          <strong>{subtitle}</strong>
        </div>
      </header>
      <StatsStrip stats={stats} />
      <FilterBar query={query} onStatusChange={handleStatusChange} onPetChange={handlePetChange} />
      <EventGrid events={events} loading={loading} error={error} />
    </main>
  );
}
