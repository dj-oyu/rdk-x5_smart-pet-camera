import { useEffect, useState } from "preact/hooks";
import { fetchDailySummary, type DailySummaryResponse } from "../lib/api";

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function DailySummary() {
  const [date, setDate] = useState(todayString);
  const [data, setData] = useState<DailySummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDailySummary(date)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [date]);

  return (
    <div class="daily-summary">
      <div class="daily-summary-header">
        <strong>Daily Summary</strong>
        <input
          type="date"
          class="daily-summary-date"
          value={date}
          onChange={(e) => setDate((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="daily-summary-body">
        {loading && <span class="daily-summary-loading">Generating...</span>}
        {error && <span class="daily-summary-error">{error}</span>}
        {data && !loading && (
          <>
            <p class="daily-summary-text">{data.summary}</p>
            <span class="daily-summary-count">{data.photo_count} photos</span>
          </>
        )}
      </div>
    </div>
  );
}
