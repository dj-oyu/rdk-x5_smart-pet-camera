import type { EventSummary } from "../lib/api";
import { photoUrl } from "../lib/api";

type EventGridProps = {
  events: EventSummary[];
  loading: boolean;
  error: string | null;
};

function formatObservedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function EventGrid({ events, loading, error }: EventGridProps) {
  if (loading) {
    return <div class="empty-state">Loading events...</div>;
  }

  if (error) {
    return <div class="empty-state error">{error}</div>;
  }

  if (events.length === 0) {
    return <div class="empty-state">No events matched the current filters.</div>;
  }

  return (
    <section class="event-grid">
      {events.map((event) => (
        <article class={`event-card ${event.status}`} key={event.id}>
          <a href={photoUrl(event.source_filename)} target="_blank" rel="noreferrer">
            <img src={photoUrl(event.source_filename)} alt={event.summary ?? event.source_filename} loading="lazy" />
          </a>
          <div class="event-card-body">
            <div class="event-meta-row">
              <span class={`status-pill ${event.status}`}>{event.status}</span>
              {event.pet_id ? <span class="pet-pill">{event.pet_id}</span> : null}
            </div>
            <h2>{event.behavior ?? "Unclassified"}</h2>
            <p>{event.summary ?? "No summary yet."}</p>
            <footer>
              <span>{formatObservedAt(event.observed_at)}</span>
              <span>{event.source_filename}</span>
            </footer>
          </div>
        </article>
      ))}
    </section>
  );
}
