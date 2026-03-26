import { describe, test, expect } from "bun:test";
import { signal } from "@preact/signals";
import { createCancellable, autoCancelOn } from "./cancellable";

describe("createCancellable", () => {
  test("starts not aborted", () => {
    const c = createCancellable();
    expect(c.aborted).toBe(false);
  });

  test("abort() marks current token as aborted", () => {
    const c = createCancellable();
    c.abort();
    expect(c.aborted).toBe(true);
  });

  test("reset() aborts the old token and issues a fresh one", () => {
    const c = createCancellable();
    const old = c.controller;
    const next = c.reset();
    expect(old.signal.aborted).toBe(true);
    expect(next.signal.aborted).toBe(false);
    expect(c.aborted).toBe(false);
    expect(c.controller).toBe(next);
  });

  test("multiple resets each abort the previous", () => {
    const c = createCancellable();
    const c1 = c.controller;
    c.reset();
    const c2 = c.controller;
    c.reset();
    const c3 = c.controller;
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(c3.signal.aborted).toBe(false);
  });

  test("abort() after reset() only aborts the latest", () => {
    const c = createCancellable();
    const old = c.controller;
    c.reset();
    // old is already aborted by reset
    expect(old.signal.aborted).toBe(true);
    // abort the new one
    c.abort();
    expect(c.aborted).toBe(true);
  });

  test("controller returns current AbortController without subscribing", () => {
    const c = createCancellable();
    const ctrl = c.controller;
    expect(ctrl).toBeInstanceOf(AbortController);
    expect(ctrl.signal.aborted).toBe(false);
  });
});

describe("async cancellation pattern", () => {
  test("token captured before async work detects cancellation", async () => {
    const c = createCancellable();
    const results: string[] = [];

    async function fakeUpscale() {
      const myController = c.controller;
      for (let i = 0; i < 5; i++) {
        if (myController.signal.aborted) {
          results.push(`cancelled-at-${i}`);
          return;
        }
        results.push(`tile-${i}`);
        await Promise.resolve(); // simulate async gap
      }
      results.push("done");
    }

    const task = fakeUpscale();
    // Cancel after first tick
    await Promise.resolve();
    c.reset();
    await task;

    expect(results[0]).toBe("tile-0");
    // Cancellation detected within a few ticks (not necessarily tick 1)
    expect(results.some(r => r.startsWith("cancelled-at-"))).toBe(true);
    expect(results).not.toContain("done");
  });

  test("new operation after reset runs independently", async () => {
    const c = createCancellable();
    const log: string[] = [];

    async function work(label: string) {
      const ctrl = c.controller;
      for (let i = 0; i < 3; i++) {
        if (ctrl.signal.aborted) { log.push(`${label}-cancelled`); return; }
        log.push(`${label}-${i}`);
        await Promise.resolve();
      }
      log.push(`${label}-done`);
    }

    // Start first, then cancel and start second
    const t1 = work("A");
    await Promise.resolve();
    c.reset();
    const t2 = work("B");
    await t1;
    await t2;

    expect(log).toContain("A-0");
    expect(log).toContain("A-cancelled");
    expect(log).toContain("B-done");
    expect(log).not.toContain("A-done");
  });
});

describe("autoCancelOn", () => {
  test("cancels when tracked signal changes", () => {
    const c = createCancellable();
    const panel = signal(0);
    const ctrl0 = c.controller;

    const dispose = autoCancelOn(c, () => { panel.value; });

    // Initial run should NOT cancel
    expect(ctrl0.signal.aborted).toBe(false);

    // Change signal → should cancel
    panel.value = 1;
    expect(ctrl0.signal.aborted).toBe(true);
    expect(c.aborted).toBe(false); // new token issued

    const ctrl1 = c.controller;
    panel.value = 2;
    expect(ctrl1.signal.aborted).toBe(true);
    expect(c.aborted).toBe(false);

    dispose();
  });

  test("tracks multiple signals", () => {
    const c = createCancellable();
    const a = signal("x");
    const b = signal(0);

    const dispose = autoCancelOn(c, () => { a.value; b.value; });
    const ctrl0 = c.controller;

    a.value = "y";
    expect(ctrl0.signal.aborted).toBe(true);

    const ctrl1 = c.controller;
    b.value = 1;
    expect(ctrl1.signal.aborted).toBe(true);

    dispose();
  });

  test("dispose stops auto-cancellation", () => {
    const c = createCancellable();
    const panel = signal(0);

    const dispose = autoCancelOn(c, () => { panel.value; });
    dispose();

    const ctrl = c.controller;
    panel.value = 99;
    expect(ctrl.signal.aborted).toBe(false); // no cancel after dispose
  });
});
