import type { PartialDetection } from "./api";

type SSEHandlers = {
  onRefresh: () => void;
  onDetectionPartial?: (data: PartialDetection) => void;
  onDetectionReady?: (data: { filename: string; count: number }) => void;
};

let source: EventSource | null = null;
let handlers: SSEHandlers = { onRefresh: () => {} };

export function startSSE(h: SSEHandlers): void {
  handlers = h;
  if (source) source.close();
  source = new EventSource("/api/events");
  source.addEventListener("event", () => handlers.onRefresh());
  source.addEventListener("detection-partial", (e: MessageEvent) => {
    handlers.onDetectionPartial?.(JSON.parse(e.data));
  });
  source.addEventListener("detection-ready", (e: MessageEvent) => {
    handlers.onDetectionReady?.(JSON.parse(e.data));
  });
}

export function stopSSE(): void {
  source?.close();
  source = null;
}

export function setDetectionHandlers(
  onPartial: ((data: PartialDetection) => void) | undefined,
  onReady: ((data: { filename: string; count: number }) => void) | undefined,
): void {
  handlers.onDetectionPartial = onPartial;
  handlers.onDetectionReady = onReady;
}
