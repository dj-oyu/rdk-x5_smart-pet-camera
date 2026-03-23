import type { EventQuery, PetNames, StatusFilter } from "../lib/api";

type FilterBarProps = {
  query: EventQuery;
  petNames: PetNames;
  onStatusChange: (status: StatusFilter) => void;
  onPetChange: (petId: string) => void;
};

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "valid", label: "Confirmed" },
  { value: "pending", label: "Pending" },
  { value: "invalid", label: "Rejected" }
];

export function FilterBar({ query, petNames, onStatusChange, onPetChange }: FilterBarProps) {
  const petOptions = [
    { value: "", label: "All pets" },
    ...Object.entries(petNames).map(([id, name]) => ({ value: id, label: name })),
  ];

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
    </section>
  );
}
