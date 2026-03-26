import { signal, effect, type Signal, type ReadonlySignal } from "@preact/signals";

export type Cancellable = {
  /** Current AbortSignal — pass to async operations */
  readonly signal: ReadonlySignal<AbortSignal>;

  /** Cancel the current operation and issue a new token */
  reset: () => AbortController;

  /** Cancel without issuing a new token */
  abort: () => void;

  /** Check if current token is aborted (non-subscribing) */
  readonly aborted: boolean;

  /** Get the current AbortController (for passing to fetch etc.) */
  readonly controller: AbortController;
};

/**
 * Create a cancellable token backed by a Signal<AbortController>.
 *
 * Any signal read inside an `effect()` that references `c.signal.value`
 * will auto-track and re-run when the token is reset.
 *
 * Use `c.aborted` (peek) inside async loops to check without subscribing.
 */
export function createCancellable(): Cancellable {
  const ctrl = signal(new AbortController());

  return {
    get signal() {
      return { get value() { return ctrl.value.signal; }, peek: () => ctrl.peek().signal } as ReadonlySignal<AbortSignal>;
    },

    reset() {
      ctrl.peek().abort();
      const next = new AbortController();
      ctrl.value = next;
      return next;
    },

    abort() {
      ctrl.peek().abort();
    },

    get aborted() {
      return ctrl.peek().signal.aborted;
    },

    get controller() {
      return ctrl.peek();
    },
  };
}

/**
 * Auto-cancel when any of the tracked signals change.
 * Returns a dispose function.
 *
 * Usage:
 *   autoCancelOn(cancellable, () => { activePanel.value; viewMode.value; });
 *   // → whenever activePanel or viewMode changes, cancellable.reset() is called
 */
export function autoCancelOn(c: Cancellable, track: () => void): () => void {
  let first = true;
  return effect(() => {
    track(); // subscribe to signals
    if (first) { first = false; return; } // skip initial run
    c.reset();
  });
}
