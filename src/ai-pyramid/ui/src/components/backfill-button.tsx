import { useEffect, useRef, useState } from "preact/hooks";
import { fetchBackfillStatus, startBackfill } from "../lib/api";

export function BackfillButton() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
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
      if (r) {
        setOpen(true);
        startPolling();
      }
    });
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function handleClick() {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setError(null);
    setConfirm(false);
    const result = await startBackfill();
    if (result.ok || result.error === "already running") {
      setRunning(true);
      startPolling();
    } else {
      setError(result.error ?? "failed");
    }
  }

  return (
    <details class="backfill-section" open={open || running} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary class="backfill-summary">Batch Operations</summary>
      <div class="backfill-content">
        <button
          type="button"
          class={`backfill-btn backfill-btn-danger ${running ? "running" : ""}`}
          disabled={running}
          onClick={handleClick}
        >
          {running ? (
            <>
              <span class="backfill-spinner" />
              Running...
            </>
          ) : confirm ? (
            "Confirm Run Backfill?"
          ) : (
            "Run Backfill"
          )}
        </button>
        {confirm && !running && (
          <button type="button" class="backfill-cancel" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        )}
        {error && <p class="backfill-error">{error}</p>}
      </div>
    </details>
  );
}
