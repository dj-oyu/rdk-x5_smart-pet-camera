import { describe, test, expect, mock, beforeEach } from "bun:test";
import { signal, effect } from "@preact/signals";
import { createCancellable, isCancelled } from "./cancellable";

describe("store loadData pattern", () => {
  test("effect + async loadData does not throw", async () => {
    const query = signal({ page: 1 });
    const loading = signal(false);
    const events = signal<string[]>([]);
    const error = signal<string | null>(null);
    const fetchCancel = createCancellable();

    const log: string[] = [];

    async function loadData() {
      const { signal: sig } = fetchCancel.reset();
      loading.value = true;
      error.value = null;
      log.push("fetch-start");
      try {
        // Simulate fetch
        await Promise.resolve();
        if (sig.aborted) { log.push("aborted"); return; }
        events.value = ["event1", "event2"];
        log.push("fetch-done");
      } catch (e) {
        if (isCancelled(e)) return;
        error.value = "fail";
      } finally {
        loading.value = false;
      }
    }

    const dispose = effect(() => {
      const q = query.value; // subscribe
      log.push(`effect-run-page-${q.page}`);
      void loadData();
    });

    // Effect runs synchronously on creation
    expect(log).toContain("effect-run-page-1");
    expect(log).toContain("fetch-start");
    expect(loading.value).toBe(true);

    // Wait for async fetch to complete
    await Promise.resolve();
    await Promise.resolve();
    expect(loading.value).toBe(false);
    expect(events.value).toEqual(["event1", "event2"]);

    // Change query → effect re-runs → new fetch
    log.length = 0;
    query.value = { page: 2 };
    expect(log).toContain("effect-run-page-2");

    await Promise.resolve();
    await Promise.resolve();
    expect(loading.value).toBe(false);

    dispose();
  });

  test("rapid query changes cancel previous fetches", async () => {
    const query = signal(0);
    const loading = signal(false);
    const result = signal(-1);
    const fetchCancel = createCancellable();

    async function loadData() {
      const { signal: sig } = fetchCancel.reset();
      loading.value = true;
      const q = query.peek(); // peek to avoid subscribing
      await Promise.resolve();
      await Promise.resolve();
      if (sig.aborted) { loading.value = false; return; }
      result.value = q;
      loading.value = false;
    }

    const dispose = effect(() => {
      query.value; // subscribe
      void loadData();
    });

    // Rapid changes
    query.value = 1;
    query.value = 2;
    query.value = 3;

    // Wait for all async to settle
    await new Promise(r => setTimeout(r, 50));

    // Only the last fetch should have succeeded
    expect(result.value).toBe(3);
    expect(loading.value).toBe(false);

    dispose();
  });

  test("effect re-run during async does not deadlock", async () => {
    const trigger = signal(0);
    const loading = signal(true);
    const fetchCancel = createCancellable();
    let loadCount = 0;

    async function loadData() {
      fetchCancel.reset();
      loading.value = true;
      loadCount++;
      await Promise.resolve();
      loading.value = false;
    }

    const dispose = effect(() => {
      trigger.value;
      void loadData();
    });

    // Initial
    await Promise.resolve();
    await Promise.resolve();
    expect(loading.value).toBe(false);

    // Trigger again
    trigger.value = 1;
    await Promise.resolve();
    await Promise.resolve();
    expect(loading.value).toBe(false);
    expect(loadCount).toBe(2);

    dispose();
  });
});
