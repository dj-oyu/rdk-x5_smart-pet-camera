import type { PetNames } from "../../lib/api";

export const PET_OPTIONS = ["mike", "chatora", "other"];

export const BEHAVIOR_OPTIONS = [
  "eating",
  "drinking",
  "sleeping",
  "playing",
  "resting",
  "moving",
  "grooming",
  "other",
];

export function petDisplay(id: string | null, petNames: PetNames): string {
  if (!id) return "unknown";
  return petNames[id] ?? id;
}
