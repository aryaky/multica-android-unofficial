// The request timeout must cover the response BODY, not just the headers
// (MULT-34). The observed failure: headers arrive, the ~1.9MB inbox body
// never finishes downloading on a weak link, and `res.json()` waits forever
// (998s in MULT-28) with the timer already cleared — the pull-to-refresh
// spinner never goes away and the query never errors.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";

// Same stubs as api.test.ts — the real stores pull in expo-secure-store.
vi.mock("@/data/server-config-store", () => ({
  getServerBaseUrl: () => "https://api.example.test",
  getCfAccessHeaders: () => ({}),
}));
vi.mock("@/lib/client-os", () => ({ CLIENT_OS: "android" }));
vi.mock("@/lib/client-version", () => ({ CLIENT_VERSION: "2.1.1-test" }));
vi.mock("@/data/workspace-store", () => ({ getCurrentSlug: () => null }));

// Keep in sync with FETCH_TIMEOUT_MS in data/api.ts.
const FETCH_TIMEOUT_MS = 30_000;

/** A response whose headers are in but whose body never resolves. */
function hangingBodyResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    url: "https://api.example.test/api/inbox",
    headers: new Headers({ "content-type": "application/json" }),
    json: () => new Promise<never>(() => {}),
  } as unknown as Response;
}

describe("request timeout covers the body read", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects with ApiError when headers arrive but the body hangs", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return hangingBodyResponse();
      }),
    );

    const request = api.listInbox();
    // Attach the expectation BEFORE the timer fires, so the rejection is
    // already handled when it lands.
    const assertion = expect(request).rejects.toThrow(
      `Request timed out after ${FETCH_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);

    // Determinate failure instead of an infinite wait: the screen can show
    // an error + Retry instead of a stuck spinner.
    await assertion;
    // Racing past the read is not enough — the native task must be aborted
    // so the transfer stops consuming the weak link.
    expect(signal?.aborted).toBe(true);
  });

  it("rejects with ApiError when an error response's body hangs", async () => {
    // The error branch reads the body too (`:489` before the fix); a hung
    // error body must not hang the request either.
    vi.stubGlobal("fetch", vi.fn(async () => hangingBodyResponse(500)));

    const assertion = expect(api.listInbox()).rejects.toThrow(
      `Request timed out after ${FETCH_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);

    await assertion;
  });

  it("resolves when a slow body arrives within the deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url: "https://api.example.test/api/inbox",
          headers: new Headers({ "content-type": "application/json" }),
          // 20s body on a slow link — inside the ceiling, must succeed.
          json: () =>
            new Promise<unknown[]>((resolve) =>
              setTimeout(() => resolve([]), 20_000),
            ),
        } as unknown as Response;
      }),
    );

    const request = api.listInbox();
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(request).resolves.toEqual([]);
  });

  it("clears the deadline once the request completed", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await api.listInbox();
    // Well past the ceiling: a timer left running would abort the finished
    // request's controller and log a phantom TIMEOUT.
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS * 2);

    expect(signal?.aborted).toBe(false);
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("TIMEOUT"),
      expect.anything(),
    );
  });
});
