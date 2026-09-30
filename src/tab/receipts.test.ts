import { describe, expect, it, vi } from "vitest";
import { createClaudeReceiptReader } from "./claude-receipts";
import { cleanReceipt, sampleReceiptReader } from "./receipts";

describe("cleanReceipt", () => {
  it("keeps items in whole cents and works out tax, tip and fees from the total", () => {
    expect(cleanReceipt({ isReceipt: true, merchant: " Taquería ", currency: "MXN", items: [{ name: "Tacos", cents: 2400 }, { name: "Bad", cents: 1.5 }], totalCents: 2900 })).toEqual({
      merchant: "Taquería", currency: "MXN", items: [{ name: "Tacos", cents: 2400 }], extrasCents: 500, totalCents: 2900,
    });
  });

  it("returns null for things that aren't usable receipts", () => {
    expect(cleanReceipt({ isReceipt: false, items: [{ name: "x", cents: 1 }], totalCents: 1 })).toBeNull();
    expect(cleanReceipt({ items: [], totalCents: 100 })).toBeNull();
    expect(cleanReceipt({ items: [{ name: "x", cents: 100 }], totalCents: 0 })).toBeNull();
    expect(cleanReceipt("nope")).toBeNull();
  });

  it("allows discounts (items worth more than the total)", () => {
    expect(cleanReceipt({ items: [{ name: "x", cents: 1000 }], totalCents: 800 })?.extrasCents).toBe(-200);
  });

  it("has a labelled sample for the simulator", async () => {
    expect((await sampleReceiptReader("https://example.com/r.jpg"))?.merchant).toMatch(/sample/);
  });
});

describe("Claude receipt reader", () => {
  const reply = (text: string, stop_reason = "end_turn") => ({ stop_reason, content: [{ type: "text", text }] });

  it("sends only the image, asks for JSON, and cleans the answer", async () => {
    const create = vi.fn(async () => reply(JSON.stringify({ isReceipt: true, merchant: "Arca", currency: "USD", items: [{ name: "Menu", cents: 9000 }], totalCents: 10800 })));
    const read = createClaudeReceiptReader({ client: { beta: { messages: { create } } } as never });
    expect(await read("https://img.test/r.jpg")).toMatchObject({ merchant: "Arca", extrasCents: 1800, totalCents: 10800 });
    const body = (create.mock.calls[0] as any[])[0];
    expect(body.messages[0].content[0]).toEqual({ type: "image", source: { type: "url", url: "https://img.test/r.jpg" } });
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.model).toBe("claude-opus-5-5");
  });

  it("returns null on refusals, bad JSON and non-https links", async () => {
    const refuse = createClaudeReceiptReader({ client: { beta: { messages: { create: async () => reply("", "refusal") } } } as never });
    expect(await refuse("https://img.test/r.jpg")).toBeNull();
    const garbled = createClaudeReceiptReader({ client: { beta: { messages: { create: async () => reply("not json") } } } as never });
    expect(await garbled("https://img.test/r.jpg")).toBeNull();
    expect(await garbled("http://img.test/r.jpg")).toBeNull();
  });
});
