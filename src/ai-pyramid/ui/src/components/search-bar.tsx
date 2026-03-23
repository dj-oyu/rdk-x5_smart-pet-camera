import { useRef, useCallback } from "preact/hooks";

type SearchBarProps = {
  value: string;
  onChange: (term: string) => void;
};

export function SearchBar({ value, onChange }: SearchBarProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleInput = useCallback(
    (e: Event) => {
      const val = (e.target as HTMLInputElement).value;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onChange(val), 300);
    },
    [onChange],
  );

  return (
    <input
      type="search"
      class="search-input"
      placeholder="Search captions..."
      value={value}
      onInput={handleInput}
    />
  );
}
