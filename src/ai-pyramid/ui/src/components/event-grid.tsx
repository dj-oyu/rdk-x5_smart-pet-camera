import { useEffect, useState } from "preact/hooks";
import { isEmbedded, type EventSummary, type PetNames } from "../lib/api";
import { photoUrl } from "../lib/api";

type EventGridProps = {
  events: EventSummary[];
  loading: boolean;
  error: string | null;
  petNames: PetNames;
  onOpenEvent: (event: EventSummary) => void;
};

function formatObservedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const inIframe = window.parent !== window;
const embedded = isEmbedded().embedded;

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

function FeaturedOverlay({ event, petNames }: { event: EventSummary; petNames: PetNames }) {
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setFaded(true), 3000);
    return () => clearTimeout(timer);
  }, [event.id]);

  return (
    <div class={`event-image-overlay ${faded ? "overlay-faded" : ""}`}>
      <span class="event-kicker">Latest</span>
      <span class="event-overlay-time">{formatObservedAt(event.observed_at)}</span>
      <div class="event-meta-row overlay-meta-row featured-meta-overlay">
        {event.pet_id ? <span class="pet-pill">{petNames[event.pet_id] ?? event.pet_id}</span> : <span class="pet-pill muted">unknown</span>}
        <span class={`status-pill ${event.status}`}>{event.status}</span>
      </div>
    </div>
  );
}

function petDisplay(petId: string | null, petNames: PetNames): string {
  if (!petId) return "unknown";
  return petNames[petId] ?? petId;
}

export function EventGrid({ events, loading, error, petNames, onOpenEvent }: EventGridProps) {
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
        // In compact/embedded mode: first card is featured
        // In standalone mode: no featured card, uniform grid
        const featured = embedded && index === 0;
        return (
          <article
            class={`event-card ${event.status} ${featured ? "featured" : "history"}`}
            key={event.id}
            onClick={() => {
              if (inIframe) {
                notifyParentLightbox(event);
              } else {
                onOpenEvent(event);
              }
            }}
            style={{ cursor: "pointer" }}
          >
            <div class="event-image-shell">
              <img
                src={photoUrl(event.source_filename)}
                alt={event.summary ?? event.source_filename}
                loading={featured ? "eager" : "lazy"}
                fetchPriority={featured ? "high" : "auto"}
              />
              {featured && <FeaturedOverlay event={event} petNames={petNames} />}
              <button
                type="button"
                class="card-edit-btn"
                title="Edit detections"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenEvent(event);
                }}
              >✎</button>
            </div>
            <div class="event-card-body">
              <p class={`event-summary ${featured ? "featured-summary" : "history-summary"}`}>
                {event.summary ?? "No summary yet."}
              </p>
              {!featured && (
                <div class="event-meta-row history-meta-row">
                  <span class="meta-text">{petDisplay(event.pet_id, petNames)}</span>
                  <span class={`status-pill ${event.status}`}>{event.status}</span>
                </div>
              )}
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
