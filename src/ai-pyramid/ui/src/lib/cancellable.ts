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
/** Error thrown when an abortable operation is cancelled. */
export class CancelledError extends Error {
  readonly reason: string;
  constructor(reason = "operation cancelled") {
    super(reason);
    this.name = "CancelledError";
    this.reason = reason;
  }
}

/**
 * Race a promise against an AbortSignal.
 * Rejects with CancelledError if the signal fires before the promise settles.
 * The reason string includes the caller context for traceability.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, reason?: string): Promise<T> {
  const msg = reason ? `cancelled: ${reason}` : "operation cancelled";
  if (signal.aborted) return Promise.reject(new CancelledError(msg));
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new CancelledError(msg)),
        { once: true },
      );
    }),
  ]);
}

/** Check if an error is a CancelledError (or a fetch AbortError) */
export function isCancelled(e: unknown): boolean {
  if (e instanceof CancelledError) return true;
  return e instanceof DOMException && e.name === "AbortError";
}

export function autoCancelOn(c: Cancellable, track: () => void): () => void {
  // undefined → first run (subscribe only). Defined → cancel + reissue.
  // peek() avoids subscribing to prev itself → no infinite loop.
  const prev = signal<AbortController | undefined>(undefined);
  return effect(() => {
    track();
    prev.peek()?.abort();
    if (prev.peek()) c.reset();
    prev.value = c.controller;
  });
}
