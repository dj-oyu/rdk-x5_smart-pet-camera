import { useEffect, useState } from "preact/hooks";
import {
  fetchDetections,
  updateDetectionOverride,
  updatePhotoPetId,
  updatePhotoFields,
  photoUrl,
  type Detection,
  type EventSummary,
  type PetNames,
} from "../lib/api";

// Comic image dimensions (fixed)
const COMIC_W = 848;
const COMIC_H = 496;

const PET_OPTIONS = ["mike", "chatora", "other"];
const BEHAVIOR_OPTIONS = [
  "eating", "sleeping", "playing", "resting", "moving", "grooming", "other",
];

const CLASS_COLORS: Record<string, string> = {
  cat: "#22c55e",
  dog: "#eab308",
  person: "#3b82f6",
  cup: "#a855f7",
  food_bowl: "#f97316",
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

export function EventDetail({ event, petNames, onClose, onUpdated }: Props) {
  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);

  // Photo-level editable fields
  const [editing, setEditing] = useState(false);
  const [petId, setPetId] = useState(event.pet_id);
  const [status, setStatus] = useState(event.status);
  const [behavior, setBehavior] = useState(event.behavior);

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

  return (
    <div class="detail-backdrop" onClick={onClose}>
      <div class="detail-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" class="detail-close" onClick={onClose}>✕</button>

        <div class="detail-image-container">
          <img
            src={photoUrl(event.source_filename)}
            alt={event.summary ?? event.source_filename}
            class="detail-image"
          />
          <svg
            class="detail-overlay"
            viewBox={`0 0 ${COMIC_W} ${COMIC_H}`}
            preserveAspectRatio="xMidYMid meet"
          >
            {detections.map((det) => (
              <g key={det.id}>
                <rect
                  x={det.bbox_x}
                  y={det.bbox_y}
                  width={det.bbox_w}
                  height={det.bbox_h}
                  fill="none"
                  stroke={bboxColor(det)}
                  stroke-width="2"
                  rx="2"
                />
                <rect
                  x={det.bbox_x}
                  y={Math.max(0, det.bbox_y - 16)}
                  width={labelText(det, petNames).length * 6.5 + 8}
                  height="16"
                  fill={bboxColor(det)}
                  rx="2"
                />
                <text
                  x={det.bbox_x + 4}
                  y={Math.max(0, det.bbox_y - 16) + 12}
                  fill="white"
                  font-size="11"
                  font-family="monospace"
                >
                  {labelText(det, petNames)}
                </text>
              </g>
            ))}
          </svg>
        </div>

        <div class="detail-info">
          <p class="detail-caption">{event.summary ?? "No summary"}</p>

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
                <li key={det.id} class="detection-row">
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
