import { describe, expect, it, vi } from "vitest";
import { HttpError, requestJson } from "./http";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const noSleep = async () => {};

describe("requestJson", () => {
  it("returns parsed JSON on success", async () => {
    const fetch = vi.fn(async () => json(200, { ok: 1 }));
    await expect(requestJson("https://x.test", { method: "GET" }, { fetch, sleep: noSleep })).resolves.toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries 429 and 5xx gateway errors, then succeeds", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}))
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, { ok: 2 }));
    await expect(requestJson("https://x.test", {}, { fetch, sleep: noSleep, retries: 3 })).resolves.toEqual({ ok: 2 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry other 4xx responses", async () => {
    const fetch = vi.fn(async () => json(400, { error: "bad number" }));
    const err: any = await requestJson("https://x.test", {}, { fetch, sleep: noSleep }).catch((e: any) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget", async () => {
    const fetch = vi.fn(async () => json(503, {}));
    await expect(requestJson("https://x.test", {}, { fetch, sleep: noSleep, retries: 2 })).rejects.toBeInstanceOf(HttpError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries network errors", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json(200, { ok: 3 }));
    await expect(requestJson("https://x.test", {}, { fetch, sleep: noSleep })).resolves.toEqual({ ok: 3 });
  });

  it("times out, and does not retry a timeout when retryOnTimeout is false", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const err: any = await requestJson("https://x.test", {}, { fetch, sleep: noSleep, timeoutMs: 10, retryOnTimeout: false }).catch(
      (e: any) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/timed out/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not include the response body in the error message", async () => {
    const fetch = vi.fn(async () => json(400, { content: "secret message text" }));
    const err: any = await requestJson("https://x.test", {}, { fetch, sleep: noSleep }).catch((e: any) => e);
    expect(err.message).not.toContain("secret");
  });
});
