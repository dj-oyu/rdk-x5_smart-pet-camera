import { describe, expect, test } from "bun:test";
import {
  annotationToBBox,
  bboxToInput,
  withBoxClass,
  withoutBox,
  type BBox,
} from "./annotation-model";

const boxes: BBox[] = [
  { class_label: "cat", x_center: 0.4, y_center: 0.5, width: 0.2, height: 0.3 },
  { class_label: "other", x_center: 0.7, y_center: 0.6, width: 0.1, height: 0.2 },
];

describe("annotation model helpers", () => {
  test("maps persisted annotations to editable boxes and strips ids on save", () => {
    const box = annotationToBBox({
      id: 12,
      frame_id: 3,
      created_at: "2026-08-23T00:00:00Z",
      ...boxes[0],
    });

    expect(box.id).toBe(12);
    expect(bboxToInput(box)).toEqual(boxes[0]);
  });

  test("updates and deletes boxes without mutating the input", () => {
    const changed = withBoxClass(boxes, 1, "mike");
    const removed = withoutBox(changed, 0);

    expect(changed[1].class_label).toBe("mike");
    expect(boxes[1].class_label).toBe("other");
    expect(removed).toEqual([changed[1]]);
  });
});
