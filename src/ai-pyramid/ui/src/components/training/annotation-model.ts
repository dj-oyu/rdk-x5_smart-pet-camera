import type { AnnotationInput, TrainingAnnotation } from "../../lib/training-api";

export const DEFAULT_CLASSES = ["cat", "mike", "chatora", "other"];

export type BBox = AnnotationInput & { id?: number };

export function annotationToBBox(annotation: TrainingAnnotation): BBox {
  return {
    class_label: annotation.class_label,
    x_center: annotation.x_center,
    y_center: annotation.y_center,
    width: annotation.width,
    height: annotation.height,
    id: annotation.id,
  };
}

export function bboxToInput(box: BBox): AnnotationInput {
  return {
    class_label: box.class_label,
    x_center: box.x_center,
    y_center: box.y_center,
    width: box.width,
    height: box.height,
  };
}

export function withBoxClass(boxes: BBox[], index: number, classLabel: string): BBox[] {
  return boxes.map((box, i) =>
    i === index ? { ...box, class_label: classLabel } : box,
  );
}

export function withoutBox(boxes: BBox[], index: number): BBox[] {
  return boxes.filter((_, i) => i !== index);
}

export function classColor(cls: string): string {
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
