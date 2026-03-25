import type { EventQuery, PetNames, StatusFilter } from "../lib/api";

const YOLO_CLASSES = ["cat", "dog", "bird", "food_bowl", "water_bowl", "person"];

type FilterBarProps = {
  query: EventQuery;
  petNames: PetNames;
  behaviors?: string[];
  onStatusChange: (status: StatusFilter) => void;
  onPetChange: (petId: string) => void;
  onBehaviorChange?: (behavior: string) => void;
  onYoloClassToggle?: (cls: string) => void;
};

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "valid", label: "Confirmed" },
  { value: "pending", label: "Pending" },
  { value: "invalid", label: "Rejected" }
];

export function FilterBar({ query, petNames, behaviors, onStatusChange, onPetChange, onBehaviorChange, onYoloClassToggle }: FilterBarProps) {
  const petEntries = Object.entries(petNames)
    .map(([id, name]) => ({ value: id, label: name }))
    .sort((a, b) => {
      // "other" (no display name override, id === label) goes last
      const aIsOther = a.value === "other";
      const bIsOther = b.value === "other";
      if (aIsOther !== bIsOther) return aIsOther ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  const petOptions = [{ value: "", label: "All pets" }, ...petEntries];

  return (
    <section class="filter-bar">
      <div class="filter-group">
        <span class="filter-label">Status</span>
        <div class="filter-cluster">
          {STATUS_OPTIONS.map((option) => (
            <button
              type="button"
              class={option.value === query.status ? "filter-chip active" : "filter-chip"}
              onClick={() => onStatusChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div class="filter-group">
        <span class="filter-label">Pet</span>
        <div class="pet-filter">
          {petOptions.map((option) => (
            <button
              type="button"
              class={option.value === query.petId ? "pet-chip active" : "pet-chip"}
              onClick={() => onPetChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {behaviors && behaviors.length > 0 && onBehaviorChange && (
        <div class="filter-group">
          <span class="filter-label">Behavior</span>
          <div class="behavior-filter">
            <button
              type="button"
              class={!query.behavior ? "filter-chip active" : "filter-chip"}
              onClick={() => onBehaviorChange("")}
            >
              All
            </button>
            {behaviors.map((b) => (
              <button
                type="button"
                class={query.behavior === b ? "filter-chip active" : "filter-chip"}
                onClick={() => onBehaviorChange(b)}
              >
                {b}
              </button>
            ))}
          </div>
        </div>
      )}
      {onYoloClassToggle && (
        <div class="filter-group">
          <span class="filter-label">Detection</span>
          <div class="filter-cluster">
            {YOLO_CLASSES.map((cls) => (
              <button
                type="button"
                class={query.yoloClasses.includes(cls) ? "filter-chip active" : "filter-chip"}
                onClick={() => onYoloClassToggle(cls)}
              >
                {cls}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
