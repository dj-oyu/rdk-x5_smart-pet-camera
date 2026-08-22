import type { BBox } from "./annotation-model";
import { classColor } from "./annotation-model";

export function AnnotationSidebar({
  boxes,
  selectedIndex,
  onSelect,
  onDelete,
}: {
  boxes: BBox[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onDelete: (index: number) => void;
}) {
  return (
    <div class="annotate-sidebar">
      <h3>Annotations</h3>
      {boxes.length === 0 ? (
        <p class="hint">Click and drag on the image to draw a bounding box.</p>
      ) : (
        <ul class="bbox-list">
          {boxes.map((box, i) => (
            <li key={i} class={`bbox-item ${selectedIndex === i ? "selected" : ""}`} onClick={() => onSelect(i)}>
              <span class="bbox-color" style={{ background: classColor(box.class_label) }} />
              <span class="bbox-label">{box.class_label}</span>
              <span class="bbox-coords">({box.x_center.toFixed(3)}, {box.y_center.toFixed(3)})</span>
              <button class="bbox-del" onClick={(e) => { e.stopPropagation(); onDelete(i); }}>x</button>
            </li>
          ))}
        </ul>
      )}
      <div class="annotate-help">
        <h4>Shortcuts</h4>
        <p>Drag: draw bbox</p>
        <p>Click bbox: select</p>
        <p>Delete/BS: remove selected</p>
        <p>Ctrl+S: save</p>
        <p>← →: prev / next</p>
        <p>Esc: back</p>
      </div>
    </div>
  );
}
