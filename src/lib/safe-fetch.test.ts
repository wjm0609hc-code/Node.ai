import { describe, expect, it, vi } from "vitest";
import { checkUrl, isPrivateAddress, safeFetchText, safeLookup } from "./safe-fetch";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "ff02::1",
  ])("private: %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"])("public: %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("checkUrl", () => {
  it.each([
    ["http://localhost/x", /not allowed/],
    ["http://127.0.0.1/", /not allowed/],
    ["http://[::1]/", /not allowed/],
    ["http://169.254.169.254/latest/meta-data", /not allowed/],
    ["http://example.com:8080/", /port/],
    ["file:///etc/passwd", /http/],
    ["http://user:pw@example.com/", /credentials/],
    ["http://metadata.google.internal/", /not allowed/],
  ])("rejects %s", (url, err) => {
    expect(() => checkUrl(url)).toThrow(err);
  });

  it("accepts ordinary web links", () => {
    expect(checkUrl("https://www.airbnb.com/rooms/1").hostname).toBe("www.airbnb.com");
  });
});

describe("safeLookup", () => {
  const resolver = (map: Record<string, string[]>) => async (host: string) =>
    (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("passes public addresses through", async () => {
    const lookup = safeLookup(resolver({ "a.test": ["93.184.216.34"] }));
    const res = await new Promise<any>((ok) => lookup("a.test", { all: true }, (err: any, addrs: any) => ok({ err, addrs })));
    expect(res.err).toBeNull();
    expect(res.addrs).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("refuses a name that resolves to a private address (DNS rebinding)", async () => {
    const lookup = safeLookup(resolver({ "evil.test": ["93.184.216.34", "10.0.0.5"] }));
    const res = await new Promise<any>((ok) => lookup("evil.test", {}, (err: any) => ok(err)));
    expect(res.message).toMatch(/private address/);
  });

  it("returns a single address when not asked for all", async () => {
    const lookup = safeLookup(resolver({ "a.test": ["93.184.216.34"] }));
    const res = await new Promise<any>((ok) => lookup("a.test", {}, (err: any, address: any, family: any) => ok({ err, address, family })));
    expect(res).toEqual({ err: null, address: "93.184.216.34", family: 4 });
  });
});

describe("safeFetchText", () => {
  const page = (body: string, init: ResponseInit = {}) =>
    new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

  it("returns HTML and the final URL", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => page("<title>hi</title>"));
    expect(await safeFetchText("https://a.test/x", { fetch })).toEqual({ url: "https://a.test/x", text: "<title>hi</title>" });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a few redirects, checking each hop", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://b.test/y" } }))
      .mockResolvedValueOnce(page("ok"));
    expect(await safeFetchText("https://a.test/x", { fetch })).toEqual({ url: "https://b.test/y", text: "ok" });

    const toPrivate = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }));
    await expect(safeFetchText("https://a.test/x", { fetch: toPrivate })).rejects.toThrow(/not allowed/);

    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://a.test/x" } }));
    await expect(safeFetchText("https://a.test/x", { fetch: loop })).rejects.toThrow(/too many redirects/);
  });

  it("stops reading past the size limit", async () => {
    const fetch = vi.fn(async () => page("x".repeat(5000)));
    const res = await safeFetchText("https://a.test/x", { fetch, maxBytes: 1000 });
    expect(res.text.length).toBe(1000);
  });

  it("refuses non-HTML and error responses", async () => {
    await expect(safeFetchText("https://a.test/x", { fetch: async () => page("{}", { headers: { "content-type": "application/pdf" } }) })).rejects.toThrow(/not a web page/);
    await expect(safeFetchText("https://a.test/x", { fetch: async () => page("no", { status: 403 }) })).rejects.toThrow(/403/);
  });

  it("times out", async () => {
    const fetch = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(safeFetchText("https://a.test/x", { fetch, timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});
