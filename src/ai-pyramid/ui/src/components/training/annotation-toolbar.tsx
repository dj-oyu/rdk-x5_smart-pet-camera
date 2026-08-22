import type { TrainingFrame } from "../../lib/training-api";
import { classColor, DEFAULT_CLASSES } from "./annotation-model";

export function AnnotationToolbar({
  frame,
  currentClass,
  selected,
  boxCount,
  dirty,
  saving,
  navigating,
  frameIndex,
  frameTotal,
  onDone,
  onPrev,
  onNext,
  onClassChange,
  onDelete,
  onSave,
  onStatusChange,
}: {
  frame: TrainingFrame;
  currentClass: string;
  selected: boolean;
  boxCount: number;
  dirty: boolean;
  saving: boolean;
  navigating: boolean;
  frameIndex?: number;
  frameTotal?: number;
  onDone: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onClassChange: (classLabel: string) => void;
  onDelete: () => void;
  onSave: () => void;
  onStatusChange: (frame: TrainingFrame, status: "approved" | "rejected") => void;
}) {
  return (
    <div class="annotate-toolbar">
      <button class="btn-back" onClick={onDone}>Back</button>
      <div class="nav-btns">
        <button class="btn-nav" onClick={onPrev} disabled={!onPrev || navigating} title="Previous frame (←)">←</button>
        {frameIndex != null && frameTotal != null && (
          <span class="nav-counter">{frameIndex} / {frameTotal}</span>
        )}
        <button class="btn-nav" onClick={onNext} disabled={!onNext || navigating} title="Next frame (→)">→</button>
      </div>
      <span class="annotate-filename">{frame.filename}</span>
      <div class="class-selector">
        {DEFAULT_CLASSES.map((cls) => (
          <button key={cls} class={`class-btn ${currentClass === cls ? "active" : ""}`} style={{ borderColor: classColor(cls) }} onClick={() => onClassChange(cls)}>
            {cls}
          </button>
        ))}
      </div>
      <button class="btn-delete" onClick={onDelete} disabled={!selected}>Delete bbox</button>
      <span class="bbox-count">{boxCount} boxes</span>
      <button class="btn-save" onClick={onSave} disabled={saving || !dirty}>{saving ? "Saving..." : "Save"}</button>
      <div class="status-btns">
        <button class={`btn-approve ${frame.status === "approved" ? "active" : ""}`} onClick={() => onStatusChange(frame, "approved")}>Approve</button>
        <button class={`btn-reject ${frame.status === "rejected" ? "active" : ""}`} onClick={() => onStatusChange(frame, "rejected")}>Reject</button>
      </div>
    </div>
  );
}
