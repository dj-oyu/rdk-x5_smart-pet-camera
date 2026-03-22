// Primary YOLO detection classes and their display colors.
// Single source of truth for all UI components.

export interface ClassDef {
  hex: string;
  rgb: [number, number, number];
}

// Main 6 classes currently targeted by YOLO
export const PRIMARY_CLASSES: Record<string, ClassDef> = {
  cat:        { hex: '#6EFF9E', rgb: [110, 255, 158] },
  dog:        { hex: '#FFC878', rgb: [255, 200, 120] },
  bird:       { hex: '#A0DCFF', rgb: [160, 220, 255] },
  food_bowl:  { hex: '#78C8FF', rgb: [120, 200, 255] },
  water_bowl: { hex: '#FF8C8C', rgb: [255, 140, 140] },
  person:     { hex: '#FFF08C', rgb: [255, 240, 140] },
};

// Secondary classes (occasionally detected)
export const SECONDARY_CLASSES: Record<string, ClassDef> = {
  dish:       { hex: '#96B4FF', rgb: [150, 180, 255] },
  book:       { hex: '#C8A0FF', rgb: [200, 160, 255] },
  cell_phone: { hex: '#FFA0F0', rgb: [255, 160, 240] },
  chair:      { hex: '#78BEFF', rgb: [120, 190, 255] },
  couch:      { hex: '#BE96FF', rgb: [190, 150, 255] },
  tv:         { hex: '#8CFFC8', rgb: [140, 255, 200] },
  laptop:     { hex: '#A0D2FF', rgb: [160, 210, 255] },
  remote:     { hex: '#FFD296', rgb: [255, 210, 150] },
  bottle:     { hex: '#78FFD2', rgb: [120, 255, 210] },
  cup:        { hex: '#FFBED2', rgb: [255, 190, 210] },
  motion:     { hex: '#FF00FF', rgb: [255, 0, 255] },
};

// All classes merged
export const ALL_CLASSES: Record<string, ClassDef> = {
  ...PRIMARY_CLASSES,
  ...SECONDARY_CLASSES,
};

// Lookup helpers
export function classHex(name: string): string {
  return ALL_CLASSES[name]?.hex ?? '#6EE7FF';
}

export function classRgb(name: string): [number, number, number] {
  return ALL_CLASSES[name]?.rgb ?? [110, 231, 255];
}
