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
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    writeQueryToLocation(query);
    let cancelled = false;

    async function load() {
      console.log("[pet-album] load:start", { query, refreshTick });
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
        console.log("[pet-album] load:success", {
          total: eventResult.total,
          eventCount: eventResult.events.length,
          firstEvent: eventResult.events[0]?.source_filename ?? null
        });
        setEvents(eventResult.events);
        setTotal(eventResult.total);
        setStats(statsResult);
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        const message = loadError instanceof Error ? loadError.message : "Failed to load data";
        console.error("[pet-album] load:error", message);
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
    const timer = window.setInterval(() => {
      console.log("[pet-album] heartbeat", { href: window.location.href, now: new Date().toISOString() });
    }, 30000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events");
    console.log("[pet-album] sse:open");
    source.addEventListener("event", (message) => {
      console.log("[pet-album] sse:event", message.data);
      setRefreshTick((current) => current + 1);
    });
    source.onerror = () => {
      console.error("[pet-album] sse:error");
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
