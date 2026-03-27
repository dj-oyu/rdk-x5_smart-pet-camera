import { useRef } from "preact/hooks";
import { useSignal, useSignalEffect } from "@preact/signals";
import { fetchBackfillStatus, startBackfill } from "../lib/api";

export function BackfillButton() {
  const running = useSignal(false);
  const error = useSignal<string | null>(null);
  const open = useSignal(false);
  const confirm = useSignal(false);
  const intervalRef = useRef<number | null>(null);

  function startPolling() {
    if (intervalRef.current) return;
    intervalRef.current = window.setInterval(async () => {
      const { running: r } = await fetchBackfillStatus();
      if (!r) {
        running.value = false;
        if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      }
    }, 5000);
  }

  useSignalEffect(() => {
    fetchBackfillStatus().then(({ running: r }) => {
      running.value = r;
      if (r) { open.value = true; startPolling(); }
    });
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  });

  async function handleClick() {
    if (!confirm.value) { confirm.value = true; return; }
    error.value = null;
    confirm.value = false;
    const result = await startBackfill();
    if (result.ok || result.error === "already running") {
      running.value = true;
      startPolling();
    } else {
      error.value = result.error ?? "failed";
    }
  }

  return (
    <details class="backfill-section" open={open.value || running.value} onToggle={e => { open.value = (e.target as HTMLDetailsElement).open; }}>
      <summary class="backfill-summary">Batch Operations</summary>
      <div class="backfill-content">
        <button type="button" class={`backfill-btn backfill-btn-danger ${running.value ? "running" : ""}`} disabled={running.value} onClick={handleClick}>
          {running.value ? (<><span class="backfill-spinner" />Running...</>) : confirm.value ? "Confirm Run Backfill?" : "Run Backfill"}
        </button>
        {confirm.value && !running.value && (
          <button type="button" class="backfill-cancel" onClick={() => { confirm.value = false; }}>Cancel</button>
        )}
        {error.value && <p class="backfill-error">{error.value}</p>}
      </div>
    </details>
  );
}
