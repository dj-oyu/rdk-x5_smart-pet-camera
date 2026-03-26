import { useSignal, useSignalEffect } from "@preact/signals";
import { fetchDailySummary, type DailySummaryResponse } from "../lib/api";

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function DailySummary() {
  const date = useSignal(todayString());
  const data = useSignal<DailySummaryResponse | null>(null);
  const loading = useSignal(false);
  const error = useSignal<string | null>(null);

  useSignalEffect(() => {
    const d = date.value;
    loading.value = true;
    error.value = null;
    let cancelled = false;
    fetchDailySummary(d)
      .then(r => { if (!cancelled) data.value = r; })
      .catch(e => { if (!cancelled) error.value = e instanceof Error ? e.message : "Failed"; })
      .finally(() => { if (!cancelled) loading.value = false; });
    return () => { cancelled = true; };
  });

  return (
    <div class="daily-summary">
      <div class="daily-summary-header">
        <strong>Daily Summary</strong>
        <input type="date" class="daily-summary-date" value={date.value}
          onChange={e => { date.value = (e.target as HTMLInputElement).value; }} />
      </div>
      <div class="daily-summary-body">
        {loading.value && <span class="daily-summary-loading">Generating...</span>}
        {error.value && <span class="daily-summary-error">{error.value}</span>}
        {data.value && !loading.value && (
          <>
            <p class="daily-summary-text">{data.value.summary}</p>
            <span class="daily-summary-count">{data.value.photo_count} photos</span>
          </>
        )}
      </div>
    </div>
  );
}
