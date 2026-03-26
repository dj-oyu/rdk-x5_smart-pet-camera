import { describe, test, expect } from "bun:test";
import { signal } from "@preact/signals";
import { createCancellable, autoCancelOn } from "./cancellable";

// We can't test upscaleTiled directly (needs TF.js + Canvas API in browser).
// Instead, test the cancellation integration pattern that detail-store will use.

describe("upscale cancellation with createCancellable", () => {
  /** Simulate a multi-step upscale that checks AbortSignal between steps */
  async function fakeUpscale(signal: AbortSignal, steps: number): Promise<string[]> {
    const log: string[] = [];
    for (let i = 0; i < steps; i++) {
      if (signal.aborted) { log.push("aborted"); return log; }
      log.push(`step-${i}`);
      await Promise.resolve(); // yield
    }
    log.push("done");
    return log;
  }

  test("completes when not cancelled", async () => {
    const c = createCancellable();
    const result = await fakeUpscale(c.controller.signal, 3);
    expect(result).toEqual(["step-0", "step-1", "step-2", "done"]);
  });

  test("aborts mid-operation via reset()", async () => {
    const c = createCancellable();
    const signal = c.controller.signal;
    const task = fakeUpscale(signal, 5);
    await Promise.resolve();
    c.reset(); // cancel
    const result = await task;
    expect(result).toContain("aborted");
    expect(result).not.toContain("done");
  });

  test("new operation after reset runs on fresh signal", async () => {
    const c = createCancellable();
    const s1 = c.controller.signal;
    const t1 = fakeUpscale(s1, 5);
    await Promise.resolve();
    c.reset();
    const s2 = c.controller.signal;
    const t2 = fakeUpscale(s2, 3);
    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1).toContain("aborted");
    expect(r2).toEqual(["step-0", "step-1", "step-2", "done"]);
  });

  test("serialized queue ensures one at a time", async () => {
    const log: string[] = [];
    let queue = Promise.resolve();

    function enqueue(fn: () => Promise<void>) {
      queue = queue.then(fn).catch(() => {});
    }

    enqueue(async () => { log.push("a-start"); await Promise.resolve(); log.push("a-end"); });
    enqueue(async () => { log.push("b-start"); await Promise.resolve(); log.push("b-end"); });

    await queue;
    expect(log).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});

describe("autoCancelOn integration with upscale", () => {
  test("panel change cancels in-flight upscale", async () => {
    const c = createCancellable();
    const activePanel = signal(0);

    const dispose = autoCancelOn(c, () => { activePanel.value; });

    // Start fake upscale on panel 0
    const signal0 = c.controller.signal;
    const t0 = (async () => {
      const log: string[] = [];
      for (let i = 0; i < 10; i++) {
        if (signal0.aborted) { log.push("cancelled"); return log; }
        log.push(`tile-${i}`);
        await Promise.resolve();
      }
      log.push("done");
      return log;
    })();

    // Switch panel after a tick
    await Promise.resolve();
    activePanel.value = 1;

    const result = await t0;
    expect(result).toContain("cancelled");
    expect(result).not.toContain("done");

    // New upscale on panel 1 should work
    const signal1 = c.controller.signal;
    expect(signal1.aborted).toBe(false);

    dispose();
  });

  test("viewMode change cancels upscale", async () => {
    const c = createCancellable();
    const viewMode = signal<"comic" | "panel">("panel");

    const dispose = autoCancelOn(c, () => { viewMode.value; });

    const sig = c.controller.signal;
    expect(sig.aborted).toBe(false);

    viewMode.value = "comic";
    expect(sig.aborted).toBe(true);
    expect(c.aborted).toBe(false); // new token issued

    dispose();
  });
});
