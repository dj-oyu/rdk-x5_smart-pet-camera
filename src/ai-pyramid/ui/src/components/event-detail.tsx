import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  fetchDetections,
  detectNow,
  updateDetectionOverride,
  updatePhotoPetId,
  updatePhotoFields,
  photoUrl,
  type Detection,
  type PartialDetection,
  type EventSummary,
  type PetNames,
} from "../lib/api";

const COMIC_W = 848;
const COMIC_H = 496;

const PET_OPTIONS = ["mike", "chatora", "other"];
const BEHAVIOR_OPTIONS = [
  "eating", "drinking", "sleeping", "playing", "resting", "moving", "grooming", "other",
];

const CLASS_COLORS: Record<string, string> = {
  cat: "#6EFF9E",
  dog: "#FFC878",
  bird: "#A0DCFF",
  food_bowl: "#78C8FF",
  water_bowl: "#FF8C8C",
  person: "#FFF08C",
  cup: "#FFBED2",
};

function bboxColor(det: Detection): string {
  return CLASS_COLORS[det.yolo_class ?? ""] ?? "#94a3b8";
}

function labelText(det: Detection, petNames: PetNames): string {
  const cls = det.yolo_class ?? "?";
  const petRaw = det.pet_id_override ?? det.pet_class;
  const pet = petRaw ? (petNames[petRaw] ?? petRaw) : null;
  const conf = det.confidence != null ? ` ${(det.confidence * 100).toFixed(0)}%` : "";
  return pet ? `${cls} (${pet})${conf}` : `${cls}${conf}`;
}

type Props = {
  event: EventSummary;
  petNames: PetNames;
  onClose: () => void;
  onUpdated?: (patch: Partial<EventSummary>) => void;
};

function useContainerScale(ref: preact.RefObject<HTMLDivElement | null>) {
  const [layout, setLayout] = useState({ scale: 1, offsetX: 0, offsetY: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const scale = Math.min(w / COMIC_W, h / COMIC_H);
      setLayout({
        scale,
        offsetX: (w - COMIC_W * scale) / 2,
        offsetY: (h - COMIC_H * scale) / 2,
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return layout;
}

export function EventDetail({ event, petNames, onClose, onUpdated }: Props) {
  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [smokeHits, setSmokeHits] = useState<PartialDetection[]>([]);
  const [scanning, setScanning] = useState(false);
  const [hoveredDetId, setHoveredDetId] = useState<number | null>(null);
  const [pinnedDetId, setPinnedDetId] = useState<number | null>(null);
  const [peekMode, setPeekMode] = useState(false);
  const activeDetId = pinnedDetId ?? hoveredDetId;

  const [editing, setEditing] = useState(false);
  const [petId, setPetId] = useState(event.pet_id);
  const [status, setStatus] = useState(event.status);
  const [behavior, setBehavior] = useState(event.behavior);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const { scale, offsetX, offsetY } = useContainerScale(containerRef);

  // Load existing detections (level1 or level2 from DB)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchDetections(event.id)
      .then((dets) => {
        if (!cancelled) setDetections(dets);
      })
      .catch(() => {
        if (!cancelled) setDetections([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [event.id]);

  // SSE: listen for progressive detection events for this photo
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("detection-partial", (e: MessageEvent) => {
      const data = JSON.parse(e.data) as PartialDetection;
      if (data.filename === event.source_filename) {
        setSmokeHits((prev) => [...prev, data]);
      }
    });
    source.addEventListener("detection-ready", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      if (data.filename === event.source_filename) {
        setScanning(false);
        setSmokeHits([]);
        // Reload final detections from DB
        fetchDetections(event.id).then(setDetections).catch(() => {});
      }
    });
    return () => source.close();
  }, [event.id, event.source_filename]);

  // Auto-start Level2 scan 3 seconds after modal opens
  useEffect(() => {
    const timer = setTimeout(() => {
      setScanning(true);
      setSmokeHits([]);
      detectNow(event.source_filename);
    }, 3000);
    return () => clearTimeout(timer);
  }, [event.source_filename]);

  function handleDetectionOverride(detId: number, newPetId: string) {
    updateDetectionOverride(detId, newPetId).then(() => {
      setDetections((prev) =>
        prev.map((d) => (d.id === detId ? { ...d, pet_id_override: newPetId } : d))
      );
      setEditingId(null);
    });
  }

  function petDisplay(id: string | null): string {
    if (!id) return "unknown";
    return petNames[id] ?? id;
  }

  async function handleSave() {
    const patch: Record<string, unknown> = {};
    if (petId !== event.pet_id && petId) {
      patch.pet_id = petId;
    }
    if (behavior !== event.behavior && behavior) {
      patch.behavior = behavior;
    }
    const newIsValid = status === "valid" ? true : status === "invalid" ? false : null;
    const oldIsValid = event.status === "valid" ? true : event.status === "invalid" ? false : null;
    if (newIsValid !== oldIsValid && newIsValid !== null) {
      patch.is_valid = newIsValid;
    }

    if (Object.keys(patch).length > 0) {
      await updatePhotoFields(event.source_filename, patch);
      onUpdated?.({ pet_id: petId, behavior, status });
    }
    setEditing(false);
  }

  function handleCancel() {
    setPetId(event.pet_id);
    setStatus(event.status);
    setBehavior(event.behavior);
    setEditing(false);
  }

  function glassBboxStyle(det: Detection): Record<string, string> {
    const w = det.bbox_w * scale;
    const h = det.bbox_h * scale;
    return {
      left: `${offsetX + det.bbox_x * scale}px`,
      top: `${offsetY + det.bbox_y * scale}px`,
      width: `${w}px`,
      height: `${h}px`,
    };
  }

  function setShineOffsetPath(el: HTMLDivElement | null, det: Detection) {
    if (!el) return;
    const w = det.bbox_w * scale;
    const h = det.bbox_h * scale;
    const path = `path("M 0,0 L ${w},0 L ${w},${h} L 0,${h} Z")`;
    (el.style as any).offsetPath = path;
    const after = el.querySelector(".glass-shine-b") as HTMLElement | null;
    if (after) (after.style as any).offsetPath = path;
  }

  return (
    <div class="detail-backdrop" onClick={onClose}>
      {/* SVG turbulence filter for fluid smoke effect */}
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter id="smoke-turbulence">
          <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="3" seed="1">
            <animate attributeName="baseFrequency" values="0.015;0.025;0.015" dur="4s" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" scale="12" />
        </filter>
      </svg>
      <div class="detail-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" class="detail-close" onClick={onClose}>✕</button>

        <div class="detail-image-container" ref={containerRef}>
          <img
            src={photoUrl(event.source_filename)}
            alt={event.summary ?? event.source_filename}
            class="detail-image"
          />
          {/* Confirmed detections: glass bbox with shine */}
          {!scanning && detections.length > 0 && (
            <div
              class={`glass-overlay ${peekMode ? "peek" : ""}`}
              onMouseEnter={() => setPeekMode(true)}
              onMouseLeave={() => { setPeekMode(false); setHoveredDetId(null); }}
            >
              {detections.map((det) => (
                <div
                  key={det.id}
                  class={`glass-bbox ${activeDetId === det.id ? "highlighted" : ""} ${peekMode && activeDetId !== det.id ? "dimmed" : ""}`}
                  style={glassBboxStyle(det)}
                  data-det-id={det.id}
                >
                  <span
                    class="glass-shine"
                    ref={(el) => {
                      if (!el) return;
                      const w = det.bbox_w * scale;
                      const h = det.bbox_h * scale;
                      (el.style as any).offsetPath = `path("M 0,0 L ${w},0 L ${w},${h} L 0,${h} Z")`;
                    }}
                  />
                  <span
                    class="glass-shine glass-shine-b"
                    ref={(el) => {
                      if (!el) return;
                      const w = det.bbox_w * scale;
                      const h = det.bbox_h * scale;
                      (el.style as any).offsetPath = `path("M 0,0 L ${w},0 L ${w},${h} L 0,${h} Z")`;
                    }}
                  />
                </div>
              ))}
            </div>
          )}
          {/* Progressive scan: smoke at each partial detection */}
          {scanning && (
            <div class="glass-overlay scan-active">
              {smokeHits.map((hit, i) => (
                <div
                  key={i}
                  class="smoke-detection"
                  style={{
                    left: `${offsetX + (hit.bbox_x + hit.bbox_w / 2) * scale}px`,
                    top: `${offsetY + (hit.bbox_y + hit.bbox_h / 2) * scale}px`,
                    width: `${Math.max(hit.bbox_w, hit.bbox_h) * scale * 1.2}px`,
                    height: `${Math.max(hit.bbox_w, hit.bbox_h) * scale * 1.2}px`,
                    animationDelay: `0s, ${(i * 0.4) % 2}s`,
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div class="detail-info">
          <div class="detail-caption-row">
            <p class="detail-caption">{event.summary ?? "No summary"}</p>
            {scanning && <span class="detect-now-status">Scanning...</span>}
          </div>

          {editing ? (
            <div class="detail-edit-form">
              <div class="edit-row">
                <label>Pet</label>
                <span class="pet-select">
                  {PET_OPTIONS.map((opt) => (
                    <button
                      type="button"
                      class={`pet-opt ${petId === opt ? "selected" : ""}`}
                      onClick={() => setPetId(opt)}
                    >
                      {petDisplay(opt)}
                    </button>
                  ))}
                </span>
              </div>
              <div class="edit-row">
                <label>Status</label>
                <span class="pet-select">
                  {(["valid", "invalid"] as const).map((opt) => (
                    <button
                      type="button"
                      class={`pet-opt ${status === opt ? "selected" : ""}`}
                      onClick={() => setStatus(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </span>
              </div>
              <div class="edit-row">
                <label>Behavior</label>
                <span class="pet-select">
                  {BEHAVIOR_OPTIONS.map((opt) => (
                    <button
                      type="button"
                      class={`pet-opt ${behavior === opt ? "selected" : ""}`}
                      onClick={() => setBehavior(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </span>
              </div>
              <div class="edit-actions">
                <button type="button" class="edit-save" onClick={handleSave}>Save</button>
                <button type="button" class="edit-cancel" onClick={handleCancel}>Cancel</button>
              </div>
            </div>
          ) : (
            <div class="detail-meta">
              <span class="pet-pill">{petDisplay(petId)}</span>
              <span class={`status-pill ${status}`}>{status}</span>
              <span>{behavior ?? ""}</span>
              <span>{new Date(event.observed_at).toLocaleString()}</span>
              <button
                type="button"
                class="detail-edit-btn"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            </div>
          )}
        </div>

        {!loading && detections.length > 0 && (
          <div class="detail-detections">
            <strong>Detections ({detections.length})</strong>
            <ul>
              {detections.map((det) => (
                <li
                  key={det.id}
                  class={`detection-row ${activeDetId === det.id ? "active" : ""}`}
                  onMouseEnter={() => setHoveredDetId(det.id)}
                  onMouseLeave={() => setHoveredDetId(null)}
                  onClick={() => setPinnedDetId(pinnedDetId === det.id ? null : det.id)}
                  onTouchStart={() => setPinnedDetId(pinnedDetId === det.id ? null : det.id)}
                >
                  <span
                    class="detection-color"
                    style={{ background: bboxColor(det) }}
                  />
                  <span class="detection-label">{labelText(det, petNames)}</span>
                  {det.yolo_class === "cat" && (
                    editingId === det.id ? (
                      <span class="pet-select">
                        {PET_OPTIONS.map((opt) => (
                          <button
                            type="button"
                            class={`pet-opt ${(det.pet_id_override ?? det.pet_class) === opt ? "selected" : ""}`}
                            onClick={() => handleDetectionOverride(det.id, opt)}
                          >
                            {petDisplay(opt)}
                          </button>
                        ))}
                        <button
                          type="button"
                          class="pet-opt cancel"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        class="detection-edit"
                        onClick={() => setEditingId(det.id)}
                      >
                        edit
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
