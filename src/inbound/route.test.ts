import { describe, expect, it, vi } from "vitest";
import type { InboundEvent } from "../messaging/types";
import { createInboundRoute } from "./route";

const event: InboundEvent = {
  type: "message",
  provider: "sendblue",
  messageId: "m1",
  groupId: null,
  from: "+15550200001",
  text: "hi",
  mediaUrls: [],
  service: "imessage",
  mentions: [],
  sentAt: new Date(),
};

function make(overrides: Partial<Parameters<typeof createInboundRoute>[0]> = {}) {
  const handle = vi.fn(async () => ({ status: "stored" as const }));
  const parse = vi.fn(() => event as InboundEvent | null);
  const route = createInboundRoute({
    secret: "s3cret",
    parse,
    pipeline: { handle } as any,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  });
  return { route, handle, parse };
}

const post = (url: string, body: string) => new Request(url, { method: "POST", body, headers: { "content-type": "application/json" } });

describe("inbound webhook route", () => {
  it("rejects requests without the right token", async () => {
    const { route, handle } = make();
    expect((await route(post("https://nod.test/api/inbound", "{}"))).status).toBe(401);
    expect((await route(post("https://nod.test/api/inbound?token=wrong", "{}"))).status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });

  it("accepts Sendblue's webhook secret header instead of the token", async () => {
    const { route, handle } = make();
    const withHeader = (name: string, value: string) =>
      new Request("https://nod.test/api/inbound", { method: "POST", body: "{}", headers: { "content-type": "application/json", [name]: value } });
    expect((await route(withHeader("sb-signing-secret", "s3cret"))).status).toBe(200);
    expect((await route(withHeader("x-webhook-secret", "s3cret"))).status).toBe(200);
    expect((await route(withHeader("sb-signing-secret", "wrong"))).status).toBe(401);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("refuses to run without a configured secret", async () => {
    const { route } = make({ secret: "" });
    expect((await route(post("https://nod.test/api/inbound?token=", "{}"))).status).toBe(500);
  });

  it("returns 400 for bad JSON or an unparseable payload", async () => {
    const { route } = make();
    expect((await route(post("https://nod.test/api/inbound?token=s3cret", "{nope"))).status).toBe(400);
    const bad = make({
      parse: () => {
        throw new Error("missing message_handle");
      },
    });
    expect((await bad.route(post("https://nod.test/api/inbound?token=s3cret", "{}"))).status).toBe(400);
  });

  it("runs the pipeline and returns 200", async () => {
    const { route, handle, parse } = make();
    const res = await route(post("https://nod.test/api/inbound?token=s3cret", '{"content":"hi"}'));
    expect(res.status).toBe(200);
    expect(parse).toHaveBeenCalledWith({ content: "hi" });
    expect(handle).toHaveBeenCalledWith(event);
  });

  it("enriches the event before running the pipeline", async () => {
    const enriched = { ...event, contactCards: [{ name: "Jake", phone: "+15550200002" }] } as InboundEvent;
    const { route, handle } = make({ enrich: async () => enriched });
    await route(post("https://nod.test/api/inbound?token=s3cret", "{}"));
    expect(handle).toHaveBeenCalledWith(enriched);
  });

  it("passes its defer function to the pipeline", async () => {
    const defer = vi.fn();
    const { route, handle } = make({ defer });
    await route(post("https://nod.test/api/inbound?token=s3cret", "{}"));
    expect(handle).toHaveBeenCalledWith(event, { defer });
  });

  it("returns 200 without running the pipeline for ignored payloads", async () => {
    const { route, handle } = make({ parse: () => null });
    expect((await route(post("https://nod.test/api/inbound?token=s3cret", "{}"))).status).toBe(200);
    expect(handle).not.toHaveBeenCalled();
  });

  it("returns 500 when storage fails so the provider retries", async () => {
    const { route } = make({
      pipeline: {
        handle: async () => {
          throw new Error("db down");
        },
      } as any,
    });
    expect((await route(post("https://nod.test/api/inbound?token=s3cret", "{}"))).status).toBe(500);
  });
});
