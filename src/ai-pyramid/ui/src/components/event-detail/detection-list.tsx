import type { Detection, PetNames } from "../../lib/api";
import { bboxColor, type DetailStore } from "../../lib/detail-store";
import { PET_OPTIONS, petDisplay } from "./presentation";

type Props = {
  store: DetailStore;
  petNames: PetNames;
  onDetectionClick: (detection: Detection) => void;
  onOverride: (detectionId: number, petId: string) => void;
};

export function DetectionList({ store: s, petNames, onDetectionClick, onOverride }: Props) {
  if (s.detLoading.value || s.visibleDets.value.length === 0) return null;

  return (
    <div class="detail-detections">
      <strong>
        Detections ({s.visibleDets.value.length})
        {s.viewMode.value === "panel" && ` — Panel ${s.activePanel.value}`}
      </strong>
      <ul>
        {s.visibleDets.value.map(det => (
          <li
            key={det.id}
            class={`det-item ${s.activeDetId.value === det.id ? "highlighted" : ""}`}
            onMouseEnter={() => { s.hoveredDetId.value = det.id; }}
            onMouseLeave={() => { s.hoveredDetId.value = null; }}
            onClick={() => onDetectionClick(det)}
          >
            <span class="det-color" style={{ background: bboxColor(det) }} />
            <span class="det-class">{det.yolo_class ?? "?"}</span>
            {(det.pet_id_override ?? det.pet_class) && (
              <span class="det-pet">{petDisplay(det.pet_id_override ?? det.pet_class, petNames)}</span>
            )}
            <span class="det-conf-wrap">
              {det.confidence != null && (
                <>
                  <span class="det-conf-bar">
                    <span class="det-conf-fill" style={{ width: `${det.confidence * 100}%`, background: bboxColor(det) }} />
                  </span>
                  <span class="det-conf">{(det.confidence * 100).toFixed(0)}%</span>
                </>
              )}
            </span>
            {det.yolo_class === "cat" && (
              s.editingId.value === det.id ? (
                <span class="pet-select">
                  {PET_OPTIONS.map(opt => (
                    <button
                      type="button"
                      class={`pet-opt ${(det.pet_id_override ?? det.pet_class) === opt ? "selected" : ""}`}
                      onClick={event => { event.stopPropagation(); onOverride(det.id, opt); }}
                    >
                      {petDisplay(opt, petNames)}
                    </button>
                  ))}
                  <button type="button" class="pet-opt cancel" onClick={event => { event.stopPropagation(); s.editingId.value = null; }}>Cancel</button>
                </span>
              ) : (
                <button type="button" class="detection-edit" onClick={event => { event.stopPropagation(); s.editingId.value = det.id; }}>edit</button>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
