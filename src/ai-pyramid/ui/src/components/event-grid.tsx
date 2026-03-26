import { useSignal, useSignalEffect } from "@preact/signals";
import { isEmbedded, type BboxSummary, type EventSummary, type PetNames } from "../lib/api";
import { photoUrl } from "../lib/api";

const COMIC_W = 848;
const COMIC_H = 496;

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
  const faded = useSignal(false);

  useSignalEffect(() => {
    faded.value = false;
    const timer = setTimeout(() => { faded.value = true; }, 3000);
    return () => clearTimeout(timer);
  });

  return (
    <div class={`event-image-overlay ${faded.value ? "overlay-faded" : ""}`}>
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

function SparkleOverlay({ bboxes }: { bboxes: BboxSummary[] }) {
  // Generate 2 particles per bbox, deterministic but varied offsets
  const particles: { left: string; top: string; delay: string; duration: string; size: number }[] = [];
  for (const b of bboxes) {
    const cx = b.bbox_x + b.bbox_w / 2;
    const cy = b.bbox_y + b.bbox_h / 2;
    // Use bbox geometry as seed — mix more aggressively to avoid collisions
    const seed = (b.bbox_x * 31 + b.bbox_y * 17 + b.bbox_w * 7) | 0;
    const spread = 0.6;
    for (let i = 0; i < 2; i++) {
      const h = seed + i * 97;
      const ox = ((h * 37) % 61 - 30) / 50 * b.bbox_w * spread;
      const oy = ((h * 53) % 51 - 25) / 50 * b.bbox_h * spread;
      particles.push({
        left: `${((cx + ox) / COMIC_W) * 100}%`,
        top: `${((cy + oy) / COMIC_H) * 100}%`,
        delay: `${((h * 43) % 3000) / 1000}s`,
        duration: `${2.5 + ((h * 67) % 1500) / 1000}s`,
        size: 3 + (h * 11) % 3,
      });
    }
  }

  return (
    <div class="sparkle-overlay">
      {particles.map((p, i) => (
        <span
          key={i}
          class="sparkle-particle"
          style={{
            left: p.left,
            top: p.top,
            width: `${p.size}px`,
            height: `${p.size}px`,
            animationDelay: p.delay,
            animationDuration: p.duration,
          }}
        />
      ))}
    </div>
  );
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
              {event.bboxes && event.bboxes.length > 0 && (
                <SparkleOverlay bboxes={event.bboxes} />
              )}
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
