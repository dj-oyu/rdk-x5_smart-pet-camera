import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  buildBgModel,
  bulkRejectByScore,
  cleanupRejected,
  fetchBgStatus,
  fetchFrame,
  fetchFrames,
  fetchTrainingStats,
  frameImageUrl,
  saveAnnotations,
  scorePendingFrames,
  setBgRef,
  syncFrames,
  updateFrameStatus,
  type AnnotationInput,
} from "./training-api";

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const originalFetch = globalThis.fetch;
const calls: FetchCall[] = [];
let response: Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function noContentResponse(status = 204): Response {
  return new Response(null, { status });
}

function requestBody(call: FetchCall): unknown {
  expect(typeof call.init?.body).toBe("string");
  return JSON.parse(call.init!.body as string);
}

beforeEach(() => {
  calls.length = 0;
  response = noContentResponse();
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(response);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("training API read contracts", () => {
  test("syncFrames posts to the sync endpoint and returns its counters", async () => {
    response = jsonResponse({ synced: 7, total_remote: 12 });

    await expect(syncFrames()).resolves.toEqual({ synced: 7, total_remote: 12 });
    expect(calls).toEqual([
      { input: "/api/training/sync", init: { method: "POST" } },
    ]);
  });

  test("fetchFrames serializes status and pagination in a stable order", async () => {
    response = jsonResponse({ frames: [], total: 0 });

    await expect(fetchFrames("approved", 25, 50)).resolves.toEqual({ frames: [], total: 0 });
    expect(calls[0]).toEqual({
      input: "/api/training/frames?status=approved&limit=25&offset=50",
      init: undefined,
    });
  });

  test("fetchFrames omits an empty status and uses default pagination", async () => {
    response = jsonResponse({ frames: [], total: 0 });

    await fetchFrames();
    expect(calls[0].input).toBe("/api/training/frames?limit=50&offset=0");
  });

  test("fetchFrame returns the frame and annotation payload unchanged", async () => {
    const payload = {
      frame: { id: 42, filename: "frame.jpg" },
      annotations: [{ id: 3, class_label: "cat" }],
    };
    response = jsonResponse(payload);

    await expect(fetchFrame(42)).resolves.toEqual(payload);
    expect(calls[0].input).toBe("/api/training/frames/42");
  });

  test("frameImageUrl exposes the backend image route", () => {
    expect(frameImageUrl(42)).toBe("/api/training/frames/42/image");
  });

  test("statistics and background status use their GET endpoints", async () => {
    const stats = {
      total: 9,
      pending: 4,
      approved: 3,
      rejected: 2,
      total_annotations: 5,
      class_counts: [{ class_label: "cat", count: 5 }],
    };
    response = jsonResponse(stats);
    await expect(fetchTrainingStats()).resolves.toEqual(stats);

    const bgStatus = {
      model_exists: true,
      model_frame_count: 3,
      model_width: 320,
      model_height: 180,
      bg_ref_count: 4,
      stale: false,
      min_refs_required: 3,
    };
    response = jsonResponse(bgStatus);
    await expect(fetchBgStatus()).resolves.toEqual(bgStatus);

    expect(calls.map(call => call.input)).toEqual([
      "/api/training/stats",
      "/api/training/bg/status",
    ]);
  });

  test("background build and scoring post and return their results", async () => {
    const built = { frame_count: 4, width: 320, height: 180, fetched_from_remote: 2 };
    response = jsonResponse(built);
    await expect(buildBgModel()).resolves.toEqual(built);

    const scored = { scored: 8, skipped_not_cached: 1 };
    response = jsonResponse(scored);
    await expect(scorePendingFrames()).resolves.toEqual(scored);

    expect(calls).toEqual([
      { input: "/api/training/bg/build", init: { method: "POST" } },
      { input: "/api/training/bg/score", init: { method: "POST" } },
    ]);
  });
});

describe("training API mutation contracts", () => {
  test("updateFrameStatus sends the selected status as JSON", async () => {
    await updateFrameStatus(11, "rejected");

    expect(calls[0].input).toBe("/api/training/frames/11/status");
    expect(calls[0].init).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
    });
    expect(requestBody(calls[0])).toEqual({ status: "rejected" });
  });

  test("saveAnnotations sends normalized boxes as a JSON array", async () => {
    const annotations: AnnotationInput[] = [{
      class_label: "dog",
      x_center: 0.5,
      y_center: 0.4,
      width: 0.25,
      height: 0.3,
    }];

    await saveAnnotations(12, annotations);

    expect(calls[0].input).toBe("/api/training/frames/12/annotations");
    expect(calls[0].init?.method).toBe("PUT");
    expect(requestBody(calls[0])).toEqual(annotations);
  });

  test("cleanupRejected preserves the remote deletion choice", async () => {
    const result = { deleted: 2, remote_deleted: 1, remote_errors: ["one.jpg"] };
    response = jsonResponse(result);

    await expect(cleanupRejected(true)).resolves.toEqual(result);
    expect(calls[0].input).toBe("/api/training/cleanup");
    expect(calls[0].init?.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({ delete_remote: true });
  });

  test("setBgRef sends the requested reference state", async () => {
    await setBgRef(13, false);

    expect(calls[0].input).toBe("/api/training/frames/13/bg_ref");
    expect(calls[0].init?.method).toBe("PUT");
    expect(requestBody(calls[0])).toEqual({ is_bg_ref: false });
  });

  test("bulkRejectByScore posts the score threshold and returns the count", async () => {
    response = jsonResponse({ rejected: 6 });

    await expect(bulkRejectByScore(0.875)).resolves.toEqual({ rejected: 6 });
    expect(calls[0].input).toBe("/api/training/bg/reject");
    expect(calls[0].init?.method).toBe("POST");
    expect(requestBody(calls[0])).toEqual({ threshold: 0.875 });
  });
});

describe("training API failure contracts", () => {
  test("read and mutation endpoints include status in their stable error messages", async () => {
    response = jsonResponse({}, 503);
    await expect(fetchFrames()).rejects.toThrow("fetch frames failed: 503");

    response = jsonResponse({}, 409);
    await expect(updateFrameStatus(1, "approved")).rejects.toThrow("update status failed: 409");

    response = jsonResponse({}, 500);
    await expect(bulkRejectByScore(0.5)).rejects.toThrow("bulk reject failed: 500");
  });

  test("background build and scoring expose the backend error body", async () => {
    response = new Response("not enough background references", { status: 422 });
    await expect(buildBgModel()).rejects.toThrow("not enough background references");

    response = new Response("background model missing", { status: 409 });
    await expect(scorePendingFrames()).rejects.toThrow("background model missing");
  });
});
