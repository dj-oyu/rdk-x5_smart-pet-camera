import { useSignal, useSignalEffect } from "@preact/signals";
import { useRef } from "preact/hooks";
import {
  fetchFrame,
  frameImageUrl,
  saveAnnotations,
  type TrainingFrame,
  type TrainingAnnotation,
  type AnnotationInput,
} from "../../lib/training-api";

const DEFAULT_CLASSES = ["cat", "mike", "chatora", "other"];

type BBox = AnnotationInput & { id?: number };

export function AnnotateCanvas({
  frame,
  onDone,
  onStatusChange,
}: {
  frame: TrainingFrame;
  onDone: () => void;
  onStatusChange: (frame: TrainingFrame, status: "approved" | "rejected") => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const bboxes = useSignal<BBox[]>([]);
  const selectedIdx = useSignal<number | null>(null);
  const currentClass = useSignal(DEFAULT_CLASSES[0]);
  const drawing = useSignal(false);
  const drawStart = useSignal<{ x: number; y: number } | null>(null);
  const drawEnd = useSignal<{ x: number; y: number } | null>(null);
  const saving = useSignal(false);
  const dirty = useSignal(false);
  const imgLoaded = useSignal(false);
  const canvasSize = useSignal({ w: 0, h: 0 });

  // Load existing annotations — frame.id is a prop (not a signal), runs once
  useSignalEffect(() => {
    fetchFrame(frame.id).then((data) => {
      bboxes.value = data.annotations.map((a: TrainingAnnotation) => ({
        class_label: a.class_label,
        x_center: a.x_center,
        y_center: a.y_center,
        width: a.width,
        height: a.height,
        id: a.id,
      }));
    });
  });

  // Load image — frame.id is a prop, runs once
  useSignalEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      imgLoaded.value = true;
    };
    img.src = frameImageUrl(frame.id);
  });

  const getCanvasScale = () => {
    const canvas = canvasRef.current;
    if (!canvas || !imgRef.current) return { sx: 1, sy: 1, ox: 0, oy: 0 };
    const img = imgRef.current;
    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.min(cw / img.width, ch / img.height);
    const ox = (cw - img.width * scale) / 2;
    const oy = (ch - img.height * scale) / 2;
    return { sx: scale, sy: scale, ox, oy };
  };

  const canvasToNorm = (cx: number, cy: number) => {
    const { sx, ox, oy } = getCanvasScale();
    const img = imgRef.current!;
    const px = (cx - ox) / sx;
    const py = (cy - oy) / sx;
    return { nx: px / img.width, ny: py / img.height };
  };

  const normToCanvas = (nx: number, ny: number) => {
    const { sx, ox, oy } = getCanvasScale();
    const img = imgRef.current!;
    return { cx: nx * img.width * sx + ox, cy: ny * img.height * sx + oy };
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d")!;
    const { sx, ox, oy } = getCanvasScale();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, ox, oy, img.width * sx, img.height * sx);

    // Draw existing bboxes
    bboxes.value.forEach((box, i) => {
      const tl = normToCanvas(box.x_center - box.width / 2, box.y_center - box.height / 2);
      const br = normToCanvas(box.x_center + box.width / 2, box.y_center + box.height / 2);
      const w = br.cx - tl.cx;
      const h = br.cy - tl.cy;

      const isSelected = selectedIdx.value === i;
      ctx.strokeStyle = isSelected ? "#ff0" : classColor(box.class_label);
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.strokeRect(tl.cx, tl.cy, w, h);

      // Label
      const label = `${box.class_label}`;
      ctx.font = "bold 13px monospace";
      const tm = ctx.measureText(label);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(tl.cx, tl.cy - 18, tm.width + 8, 18);
      ctx.fillStyle = "#000";
      ctx.fillText(label, tl.cx + 4, tl.cy - 4);
    });

    // Draw in-progress bbox
    if (drawing.value && drawStart.value && drawEnd.value) {
      const x = Math.min(drawStart.value.x, drawEnd.value.x);
      const y = Math.min(drawStart.value.y, drawEnd.value.y);
      const w = Math.abs(drawEnd.value.x - drawStart.value.x);
      const h = Math.abs(drawEnd.value.y - drawStart.value.y);
      ctx.strokeStyle = "#0ff";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  };

  const handleMouseDown = (e: MouseEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    // Check if clicking on existing bbox
    const { nx, ny } = canvasToNorm(x, y);
    const hitIdx = bboxes.value.findIndex((b) => {
      const left = b.x_center - b.width / 2;
      const right = b.x_center + b.width / 2;
      const top = b.y_center - b.height / 2;
      const bottom = b.y_center + b.height / 2;
      return nx >= left && nx <= right && ny >= top && ny <= bottom;
    });

    if (hitIdx >= 0 && !e.shiftKey) {
      selectedIdx.value = hitIdx;
      return;
    }

    // Start drawing new bbox
    selectedIdx.value = null;
    drawing.value = true;
    drawStart.value = { x, y };
    drawEnd.value = { x, y };
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!drawing.value) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    drawEnd.value = { x, y };
  };

  const handleMouseUp = () => {
    if (!drawing.value || !drawStart.value || !drawEnd.value) return;
    drawing.value = false;

    const s = drawStart.value;
    const e = drawEnd.value;
    const minSize = 5;
    if (Math.abs(e.x - s.x) < minSize || Math.abs(e.y - s.y) < minSize) {
      drawStart.value = null;
      drawEnd.value = null;
      return;
    }

    // Convert to normalized coords
    const tl = canvasToNorm(Math.min(s.x, e.x), Math.min(s.y, e.y));
    const br = canvasToNorm(Math.max(s.x, e.x), Math.max(s.y, e.y));

    const width = Math.max(0, Math.min(1, br.nx) - Math.max(0, tl.nx));
    const height = Math.max(0, Math.min(1, br.ny) - Math.max(0, tl.ny));
    const x_center = Math.max(0, tl.nx) + width / 2;
    const y_center = Math.max(0, tl.ny) + height / 2;

    if (width > 0.005 && height > 0.005) {
      bboxes.value = [
        ...bboxes.value,
        { class_label: currentClass.value, x_center, y_center, width, height },
      ];
      selectedIdx.value = bboxes.value.length - 1;
      dirty.value = true;
    }

    drawStart.value = null;
    drawEnd.value = null;
  };

  const handleDelete = () => {
    if (selectedIdx.value === null) return;
    bboxes.value = bboxes.value.filter((_, i) => i !== selectedIdx.value);
    selectedIdx.value = null;
    dirty.value = true;
  };

  const handleClassChange = (cls: string) => {
    if (selectedIdx.value !== null) {
      bboxes.value = bboxes.value.map((b, i) =>
        i === selectedIdx.value ? { ...b, class_label: cls } : b,
      );
      dirty.value = true;
    }
    currentClass.value = cls;
  };

  const handleSave = async () => {
    saving.value = true;
    try {
      const inputs: AnnotationInput[] = bboxes.value.map((b) => ({
        class_label: b.class_label,
        x_center: b.x_center,
        y_center: b.y_center,
        width: b.width,
        height: b.height,
      }));
      await saveAnnotations(frame.id, inputs);
      dirty.value = false;
    } catch (e) {
      alert(`Save failed: ${e}`);
    } finally {
      saving.value = false;
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      handleDelete();
    } else if (e.key === "Escape") {
      if (drawing.value) {
        drawing.value = false;
        drawStart.value = null;
        drawEnd.value = null;
      } else {
        onDone();
      }
    } else if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  // Keydown listener — no signal reads in setup, runs once
  useSignalEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  // Resize canvas to fill container.
  // Multiply by devicePixelRatio so the buffer matches physical pixels;
  // CSS flex:1 keeps the display size at CSS pixels → sharp on HiDPI.
  // Writes canvasSize only — no signal reads here, runs once.
  useSignalEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = parent.clientWidth * dpr;
      canvas.height = parent.clientHeight * dpr;
      canvasSize.value = { w: canvas.width, h: canvas.height };
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  });

  // Redraw — reads canvasSize (resize), imgLoaded, and all signals touched
  // inside redraw() (bboxes, drawEnd, selectedIdx, drawing, drawStart).
  useSignalEffect(() => {
    canvasSize.value; // subscribe to resize
    if (imgLoaded.value) redraw();
  });

  return (
    <div class="annotate-view">
      <div class="annotate-toolbar">
        <button class="btn-back" onClick={onDone}>
          Back
        </button>
        <span class="annotate-filename">{frame.filename}</span>
        <div class="class-selector">
          {DEFAULT_CLASSES.map((cls) => (
            <button
              key={cls}
              class={`class-btn ${currentClass.value === cls ? "active" : ""}`}
              style={{ borderColor: classColor(cls) }}
              onClick={() => handleClassChange(cls)}
            >
              {cls}
            </button>
          ))}
        </div>
        <button
          class="btn-delete"
          onClick={handleDelete}
          disabled={selectedIdx.value === null}
        >
          Delete bbox
        </button>
        <span class="bbox-count">{bboxes.value.length} boxes</span>
        <button
          class="btn-save"
          onClick={handleSave}
          disabled={saving.value || !dirty.value}
        >
          {saving.value ? "Saving..." : "Save"}
        </button>
        <div class="status-btns">
          <button
            class={`btn-approve ${frame.status === "approved" ? "active" : ""}`}
            onClick={() => onStatusChange(frame, "approved")}
          >
            Approve
          </button>
          <button
            class={`btn-reject ${frame.status === "rejected" ? "active" : ""}`}
            onClick={() => onStatusChange(frame, "rejected")}
          >
            Reject
          </button>
        </div>
      </div>
      <div class="annotate-canvas-wrap">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        />
      </div>
      <div class="annotate-sidebar">
        <h3>Annotations</h3>
        {bboxes.value.length === 0 ? (
          <p class="hint">Click and drag on the image to draw a bounding box.</p>
        ) : (
          <ul class="bbox-list">
            {bboxes.value.map((box, i) => (
              <li
                key={i}
                class={`bbox-item ${selectedIdx.value === i ? "selected" : ""}`}
                onClick={() => (selectedIdx.value = i)}
              >
                <span
                  class="bbox-color"
                  style={{ background: classColor(box.class_label) }}
                />
                <span class="bbox-label">{box.class_label}</span>
                <span class="bbox-coords">
                  ({box.x_center.toFixed(3)}, {box.y_center.toFixed(3)})
                </span>
                <button
                  class="bbox-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    bboxes.value = bboxes.value.filter((_, j) => j !== i);
                    if (selectedIdx.value === i) selectedIdx.value = null;
                    dirty.value = true;
                  }}
                >
                  x
                </button>
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
          <p>Esc: back</p>
        </div>
      </div>
    </div>
  );
}

function classColor(cls: string): string {
  switch (cls) {
    case "cat":
      return "#4caf50";
    case "mike":
      return "#ff9800";
    case "chatora":
      return "#f44336";
    case "other":
      return "#9c27b0";
    default:
      return "#2196f3";
  }
}
