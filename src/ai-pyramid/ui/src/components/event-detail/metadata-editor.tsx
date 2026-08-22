import type { EventSummary, PetNames } from "../../lib/api";
import type { DetailStore } from "../../lib/detail-store";
import { BEHAVIOR_OPTIONS, PET_OPTIONS, petDisplay } from "./presentation";

type Props = {
  event: EventSummary;
  petNames: PetNames;
  store: DetailStore;
  onSave: () => void;
  onCancel: () => void;
};

export function MetadataEditor({ event, petNames, store: s, onSave, onCancel }: Props) {
  if (!s.editing.value) {
    return (
      <div class="detail-meta">
        <span class="pet-pill">{petDisplay(s.formPetId.value, petNames)}</span>
        <span class={`status-pill ${s.formStatus.value}`}>{s.formStatus.value}</span>
        <span>{s.formBehavior.value ?? ""}</span>
        <span>{new Date(event.observed_at).toLocaleString()}</span>
        <button type="button" class="detail-edit-btn" onClick={() => { s.editing.value = true; }}>Edit</button>
      </div>
    );
  }

  return (
    <div class="detail-edit-form">
      <div class="edit-row">
        <label>Pet</label>
        <span class="pet-select">
          {PET_OPTIONS.map(opt => (
            <button type="button" class={`pet-opt ${s.formPetId.value === opt ? "selected" : ""}`} onClick={() => { s.formPetId.value = opt; }}>
              {petDisplay(opt, petNames)}
            </button>
          ))}
        </span>
      </div>
      <div class="edit-row">
        <label>Status</label>
        <span class="pet-select">
          {(["valid", "invalid"] as const).map(opt => (
            <button type="button" class={`pet-opt ${s.formStatus.value === opt ? "selected" : ""}`} onClick={() => { s.formStatus.value = opt; }}>
              {opt}
            </button>
          ))}
        </span>
      </div>
      <div class="edit-row">
        <label>Behavior</label>
        <span class="pet-select">
          {BEHAVIOR_OPTIONS.map(opt => (
            <button type="button" class={`pet-opt ${s.formBehavior.value === opt ? "selected" : ""}`} onClick={() => { s.formBehavior.value = opt; }}>
              {opt}
            </button>
          ))}
        </span>
      </div>
      <div class="edit-actions">
        <button type="button" class="edit-save" onClick={onSave}>Save</button>
        <button type="button" class="edit-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
