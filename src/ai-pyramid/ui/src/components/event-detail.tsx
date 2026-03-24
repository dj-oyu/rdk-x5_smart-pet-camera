import { useEffect, useState } from "preact/hooks";
import {
  fetchDetections,
  updateDetectionOverride,
  updatePhotoPetId,
  photoUrl,
  type Detection,
  type EventSummary,
} from "../lib/api";

// Comic image dimensions (fixed)
const COMIC_W = 848;
const COMIC_H = 496;

const PET_OPTIONS = ["mike", "chatora", "other"];

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

function labelText(det: Detection): string {
  const cls = det.yolo_class ?? "?";
  const pet = det.pet_id_override ?? det.pet_class;
  const conf = det.confidence != null ? ` ${(det.confidence * 100).toFixed(0)}%` : "";
  return pet ? `${cls} (${pet})${conf}` : `${cls}${conf}`;
}

type Props = {
  event: EventSummary;
  onClose: () => void;
};

export function EventDetail({ event, onClose }: Props) {
  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingPetId, setEditingPetId] = useState(false);
  const [currentPetId, setCurrentPetId] = useState(event.pet_id);

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

  function handleOverride(detId: number, petId: string) {
    updateDetectionOverride(detId, petId).then(() => {
      setDetections((prev) =>
        prev.map((d) => (d.id === detId ? { ...d, pet_id_override: petId } : d))
      );
      setEditingId(null);
    });
  }

  function handlePhotoPetId(petId: string) {
    updatePhotoPetId(event.source_filename, petId).then(() => {
      setCurrentPetId(petId);
      setEditingPetId(false);
    });
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
                  width={labelText(det).length * 6.5 + 8}
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
                  {labelText(det)}
                </text>
              </g>
            ))}
          </svg>
        </div>

        <div class="detail-info">
          <p class="detail-caption">{event.summary ?? "No summary"}</p>
          <div class="detail-meta">
            <span class="detail-pet-id">
              {editingPetId ? (
                <span class="pet-select">
                  {PET_OPTIONS.map((opt) => (
                    <button
                      type="button"
                      class={`pet-opt ${currentPetId === opt ? "selected" : ""}`}
                      onClick={() => handlePhotoPetId(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                  <button
                    type="button"
                    class="pet-opt cancel"
                    onClick={() => setEditingPetId(false)}
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <>
                  {currentPetId ?? "unknown"}
                  <button
                    type="button"
                    class="detection-edit"
                    onClick={() => setEditingPetId(true)}
                  >
                    edit
                  </button>
                </>
              )}
            </span>
            <span class={`status-pill ${event.status}`}>{event.status}</span>
            <span>{event.behavior ?? ""}</span>
            <span>{new Date(event.observed_at).toLocaleString()}</span>
          </div>
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
                  <span class="detection-label">{labelText(det)}</span>
                  {det.yolo_class === "cat" && (
                    editingId === det.id ? (
                      <span class="pet-select">
                        {PET_OPTIONS.map((opt) => (
                          <button
                            type="button"
                            class={`pet-opt ${(det.pet_id_override ?? det.pet_class) === opt ? "selected" : ""}`}
                            onClick={() => handleOverride(det.id, opt)}
                          >
                            {opt}
                          </button>
                        ))}
                        <button
                          type="button"
                          class="pet-opt cancel"
                          onClick={() => setEditingId(null)}
                        >
                          ✕
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
