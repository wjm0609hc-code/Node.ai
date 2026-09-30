import { describe, expect, it } from "vitest";
import { balances, equalSplit, exactSplit, receiptSplit, settleTransfers, TabMathError } from "./math";

const sum = (shares: Array<{ amountCents: number }>) => shares.reduce((a, s) => a + s.amountCents, 0);

describe("equalSplit", () => {
  it("splits evenly, giving leftover cents to the first people", () => {
    expect(equalSplit(9000, ["a", "b", "c"])).toEqual([
      { userId: "a", amountCents: 3000 },
      { userId: "b", amountCents: 3000 },
      { userId: "c", amountCents: 3000 },
    ]);
    expect(equalSplit(1000, ["a", "b", "c"]).map((s) => s.amountCents)).toEqual([334, 333, 333]);
  });

  it("always adds up to the total", () => {
    for (const total of [1, 99, 1001, 123_457]) for (const n of [1, 2, 3, 7, 11]) {
      const people = Array.from({ length: n }, (_, i) => `p${i}`);
      expect(sum(equalSplit(total, people))).toBe(total);
    }
  });

  it("merges duplicate people and rejects bad input", () => {
    expect(equalSplit(1000, ["a", "a", "b"]).map((s) => s.userId)).toEqual(["a", "b"]);
    expect(() => equalSplit(1000, [])).toThrow(TabMathError);
    expect(() => equalSplit(0, ["a"])).toThrow(TabMathError);
    expect(() => equalSplit(10.5, ["a"])).toThrow(TabMathError);
  });
});

describe("exactSplit", () => {
  it("uses the amounts given when they add up", () => {
    expect(exactSplit(5000, [{ userId: "a", amountCents: 2000 }, { userId: "b", amountCents: 3000 }])).toEqual([
      { userId: "a", amountCents: 2000 },
      { userId: "b", amountCents: 3000 },
    ]);
  });

  it("refuses amounts that don't add up to the total", () => {
    expect(() => exactSplit(5000, [{ userId: "a", amountCents: 2000 }])).toThrow(/add up to \$20, not \$50/);
    expect(() => exactSplit(5000, [{ userId: "a", amountCents: -1 }, { userId: "b", amountCents: 5001 }])).toThrow(TabMathError);
  });
});

describe("receiptSplit", () => {
  const receipt = {
    merchant: "Taquería", currency: "USD", extrasCents: 1000, totalCents: 5000,
    items: [{ name: "Tacos", cents: 2000 }, { name: "Burrito", cents: 1000 }, { name: "Chips", cents: 1000 }],
  };

  it("charges each person their items plus a proportional share of tax and tip", () => {
    // a had tacos (2000), b the burrito (1000), chips shared by everyone (a, b, c).
    const shares = receiptSplit(receipt, [{ item: 1, people: ["a"] }, { item: 2, people: ["b"] }], ["a", "b", "c"]);
    // Item subtotals: a 2000 + 333.3, b 1000 + 333.3, c 333.3; extras 1000 split in proportion.
    expect(sum(shares)).toBe(5000);
    const by = Object.fromEntries(shares.map((s) => [s.userId, s.amountCents]));
    expect(by).toEqual({ a: 2917, b: 1667, c: 416 });
  });

  it("splits everything evenly when no items are assigned", () => {
    expect(receiptSplit(receipt, [], ["a", "b"]).map((s) => s.amountCents)).toEqual([2500, 2500]);
  });

  it("rejects unknown item numbers and items with nobody", () => {
    expect(() => receiptSplit(receipt, [{ item: 9, people: ["a"] }], ["a"])).toThrow(/no item 9/);
    expect(() => receiptSplit(receipt, [{ item: 1, people: [] }], ["a"])).toThrow(TabMathError);
  });

  it("adds up exactly for awkward numbers", () => {
    const odd = { ...receipt, items: [{ name: "x", cents: 1001 }, { name: "y", cents: 999 }, { name: "z", cents: 333 }], extrasCents: 457, totalCents: 2790 };
    expect(sum(receiptSplit(odd, [{ item: 1, people: ["a", "b", "c"] }, { item: 3, people: ["c"] }], ["a", "b", "c", "d"]))).toBe(2790);
  });
});

describe("balances and settling up", () => {
  const entry = (payerUserId: string, amountCents: number, shares: Array<[string, number]>) => ({
    payerUserId, amountCents, shares: shares.map(([userId, cents]) => ({ userId, amountCents: cents })),
  });

  it("works out what each person is owed (+) or owes (-)", () => {
    const b = balances([
      entry("will", 12000, [["will", 3000], ["jake", 3000], ["sarah", 3000], ["mike", 3000]]),
      entry("sarah", 4000, [["jake", 2000], ["mike", 2000]]),
    ]);
    expect(Object.fromEntries(b)).toEqual({ will: 9000, jake: -5000, sarah: 1000, mike: -5000 });
    expect([...b.values()].reduce((a, v) => a + v, 0)).toBe(0);
  });

  it("settles with few payments, biggest debts first", () => {
    const t = settleTransfers(new Map([["will", 9000], ["jake", -5000], ["sarah", 1000], ["mike", -5000]]));
    expect(t).toEqual([
      { from: "jake", to: "will", amountCents: 5000 },
      { from: "mike", to: "will", amountCents: 4000 },
      { from: "mike", to: "sarah", amountCents: 1000 },
    ]);
  });

  it("clears every balance and never needs more than n - 1 payments", () => {
    for (let seed = 1; seed < 40; seed++) {
      const people = Array.from({ length: 2 + (seed % 7) }, (_, i) => `p${i}`);
      let rnd = seed;
      const next = () => (rnd = (rnd * 1103515245 + 12345) % 2 ** 31);
      const b = new Map(people.map((p) => [p, 0]));
      for (let k = 0; k < 6; k++) {
        const payer = people[next() % people.length]!;
        const shares = equalSplit(100 + (next() % 50_000), people);
        b.set(payer, b.get(payer)! + sum(shares));
        for (const s of shares) b.set(s.userId, b.get(s.userId)! - s.amountCents);
      }
      const transfers = settleTransfers(b, 0);
      expect(transfers.length).toBeLessThanOrEqual(people.length - 1);
      for (const t of transfers) {
        b.set(t.from, b.get(t.from)! + t.amountCents);
        b.set(t.to, b.get(t.to)! - t.amountCents);
      }
      expect([...b.values()].every((v) => v === 0)).toBe(true);
    }
  });

  it("skips payments under the minimum", () => {
    expect(settleTransfers(new Map([["a", 50], ["b", -50]]))).toEqual([]);
    expect(settleTransfers(new Map([["a", 0], ["b", 0]]))).toEqual([]);
  });
});
