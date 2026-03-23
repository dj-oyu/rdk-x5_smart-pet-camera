import type { EventSummary } from "../lib/api";
import { photoUrl } from "../lib/api";

type EventGridProps = {
  events: EventSummary[];
  loading: boolean;
  error: string | null;
  onOpenEvent: (event: EventSummary) => void;
};

function formatObservedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const inIframe = window.parent !== window;

function notifyParentLightbox(event: EventSummary): void {
  const src = new URL(photoUrl(event.source_filename), window.location.origin).href;
  window.parent.postMessage({
    type: "album-lightbox",
    src,
    meta: {
      date: event.observed_at,
      pet: event.pet_id ?? undefined,
      behavior: event.behavior ?? undefined,
      caption: event.summary ?? undefined,
    },
  }, "*");
}

export function EventGrid({ events, loading, error, onOpenEvent }: EventGridProps) {
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
      {events.map((event, index) => {
        const featured = index === 0;
        return (
          <article class={`event-card ${event.status} ${featured ? "featured" : "history"}`} key={event.id}>
            <a
              href={photoUrl(event.source_filename)}
              target="_blank"
              rel="noreferrer"
              onClick={(clickEvent) => {
                clickEvent.preventDefault();
                if (inIframe) {
                  notifyParentLightbox(event);
                } else {
                  onOpenEvent(event);
                }
              }}
            >
              <div class="event-image-shell">
                <img
                  src={photoUrl(event.source_filename)}
                  alt={event.summary ?? event.source_filename}
                  loading={featured ? "eager" : "lazy"}
                  fetchPriority={featured ? "high" : "auto"}
                />
                {featured ? (
                  <div class="event-image-overlay">
                    <span class="event-kicker">Latest</span>
                    <span class="event-overlay-time">{formatObservedAt(event.observed_at)}</span>
                    <div class="event-meta-row overlay-meta-row featured-meta-overlay">
                      {event.pet_id ? <span class="pet-pill">{event.pet_id}</span> : <span class="pet-pill muted">unknown</span>}
                      <span class={`status-pill ${event.status}`}>{event.status}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </a>
            <div class="event-card-body">
              <p class={`event-summary ${featured ? "featured-summary" : "history-summary"}`}>
                {event.summary ?? "No summary yet."}
              </p>
              {!featured ? (
                <div class="event-meta-row history-meta-row">
                  <span class="meta-text">{event.pet_id ?? "unknown"}</span>
                  <span class={`status-pill ${event.status}`}>{event.status}</span>
                </div>
              ) : null}
              <footer>
                <span class="event-behavior">{event.behavior ?? "Unclassified"}</span>
                <span>{formatObservedAt(event.observed_at)}</span>
              </footer>
            </div>
          </article>
        );
      })}
    </section>
  );
}
