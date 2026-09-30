// Reading receipt photos. Production asks Claude to read the image
// (claude-receipts.ts); the web simulator uses a labelled sample receipt.

import type { ParsedReceipt } from "../db/store";

export type ReceiptReader = (imageUrl: string) => Promise<ParsedReceipt | null>;

export const noReceiptReader: ReceiptReader = async () => {
  throw new Error("receipt reading isn't set up here");
};

const MAX_ITEMS = 60;

/** Checks and cleans what a reader returned: whole cents, a real total, extras = total minus items. Null if it isn't usable. */
export function cleanReceipt(raw: unknown): ParsedReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.isReceipt === false) return null;
  const items = Array.isArray(r.items) ? r.items : [];
  const cleanItems = items
    .map((i) => i as Record<string, unknown>)
    .filter((i) => typeof i.name === "string" && Number.isInteger(i.cents) && (i.cents as number) > 0)
    .slice(0, MAX_ITEMS)
    .map((i) => ({ name: (i.name as string).trim().slice(0, 60) || "Item", cents: i.cents as number }));
  const total = r.totalCents;
  if (!cleanItems.length || !Number.isInteger(total) || (total as number) <= 0) return null;
  const itemsSum = cleanItems.reduce((a, i) => a + i.cents, 0);
  return {
    merchant: typeof r.merchant === "string" && r.merchant.trim() ? r.merchant.trim().slice(0, 80) : null,
    currency: typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency) ? r.currency : "USD",
    items: cleanItems,
    extrasCents: (total as number) - itemsSum,
    totalCents: total as number,
  };
}

/** The web simulator's stand-in (it can't upload real photos). */
export const sampleReceiptReader: ReceiptReader = async () =>
  cleanReceipt({
    merchant: "Taquería Late (sample receipt)",
    currency: "USD",
    items: [
      { name: "Tacos al pastor x4", cents: 2400 },
      { name: "Burrito", cents: 1400 },
      { name: "Guacamole", cents: 1100 },
      { name: "Margaritas x3", cents: 3300 },
    ],
    totalCents: 9860,
  });
