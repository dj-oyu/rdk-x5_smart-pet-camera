import type { EventQuery, StatusFilter } from "../lib/api";

type FilterBarProps = {
  query: EventQuery;
  onStatusChange: (status: StatusFilter) => void;
  onPetChange: (petId: string) => void;
};

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All events" },
  { value: "valid", label: "Confirmed" },
  { value: "pending", label: "Pending" },
  { value: "invalid", label: "Rejected" }
];

const PET_OPTIONS = [
  { value: "", label: "All pets" },
  { value: "chatora", label: "Chatora" },
  { value: "mike", label: "Mike" }
];

export function FilterBar({ query, onStatusChange, onPetChange }: FilterBarProps) {
  return (
    <section class="filter-bar">
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
      <div class="pet-filter">
        {PET_OPTIONS.map((option) => (
          <button
            type="button"
            class={option.value === query.petId ? "pet-chip active" : "pet-chip"}
            onClick={() => onPetChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
