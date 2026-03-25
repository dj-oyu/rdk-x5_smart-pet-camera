import { useEffect, useRef, useState } from "preact/hooks";
import { fetchBackfillStatus, startBackfill } from "../lib/api";

export function BackfillButton() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<number | null>(null);

  function startPolling() {
    if (intervalRef.current) return;
    intervalRef.current = window.setInterval(async () => {
      const { running: r } = await fetchBackfillStatus();
      if (!r) {
        setRunning(false);
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    }, 5000);
  }

  useEffect(() => {
    fetchBackfillStatus().then(({ running: r }) => {
      setRunning(r);
      if (r) startPolling();
    });
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function handleClick() {
    setError(null);
    const result = await startBackfill();
    if (result.ok || result.error === "already running") {
      setRunning(true);
      startPolling();
    } else {
      setError(result.error ?? "failed");
    }
  }

  return (
    <div class="backfill-section">
      <button
        type="button"
        class={`backfill-btn ${running ? "running" : ""}`}
        disabled={running}
        onClick={handleClick}
      >
        {running ? (
          <>
            <span class="backfill-spinner" />
            Running...
          </>
        ) : (
          "Run Backfill"
        )}
      </button>
      {error && <p class="backfill-error">{error}</p>}
    </div>
  );
}
