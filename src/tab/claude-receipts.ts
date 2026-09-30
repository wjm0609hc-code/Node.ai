// Reads a receipt photo with Claude: line items and the total, as JSON. It sees
// only the image, never the chat.

import Anthropic from "@anthropic-ai/sdk";
import type { ClassifierClient } from "../detection/classifier";
import { cleanReceipt, type ReceiptReader } from "./receipts";

const SYSTEM = `You read receipts for a group splitting a bill. From the image, list each line item with its price, and the final total (after tax, tip, fees and discounts).
Rules: prices in integer cents ($12.50 -> 1250). Keep quantities in the item name ("Tacos x4") with the line's total price. Leave out tax, tip, service charges and subtotal lines from items; they are covered by the total.
If there's a handwritten tip and total, use the handwritten total. If the image isn't a receipt or you can't read the total, set isReceipt to false.`;

const SCHEMA = {
  type: "object",
  properties: {
    isReceipt: { type: "boolean" },
    merchant: { type: ["string", "null"] },
    currency: { type: "string", description: "ISO 4217 code, e.g. USD or MXN" },
    items: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" }, cents: { type: "integer" } }, required: ["name", "cents"], additionalProperties: false },
    },
    totalCents: { type: "integer" },
  },
  required: ["isReceipt", "merchant", "currency", "items", "totalCents"],
  additionalProperties: false,
} as const;

const CURRENT_GEN = /^claude-(?:opus-5|fable-5|sonnet-5-5)/;

export function createClaudeReceiptReader(opts: { client?: ClassifierClient; model?: string; timeoutMs?: number } = {}): ReceiptReader {
  let client = opts.client;
  const model = opts.model ?? process.env.NOD_RECEIPT_MODEL ?? process.env.NOD_MODEL ?? "claude-opus-5-5";
  const current = CURRENT_GEN.test(model);

  return async (imageUrl) => {
    if (!/^https:\/\//i.test(imageUrl)) return null;
    client ??= new Anthropic();
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 4096,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: imageUrl } },
              { type: "text", text: "Read this receipt." },
            ],
          },
        ],
        output_config: { ...(current ? { effort: "low" as const } : {}), format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> } },
        ...(current ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { timeout: opts.timeoutMs ?? 60_000, maxRetries: 2 },
    );
    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;
    try {
      return cleanReceipt(JSON.parse(block.text));
    } catch {
      return null;
    }
  };
}
