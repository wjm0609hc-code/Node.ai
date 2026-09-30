import { describe, expect, it } from "vitest";
import { MAX_SHARE_CENTS, MIN_SHARE_CENTS, splitShares } from "./split";

describe("splitShares", () => {
  it("charges each payer the per-person amount", () => {
    expect(splitShares({ perPersonCents: 31000, payers: ["a", "b", "c"] })).toEqual([
      { userId: "a", amountCents: 31000 },
      { userId: "b", amountCents: 31000 },
      { userId: "c", amountCents: 31000 },
    ]);
  });

  it("splits a total evenly, counting the requester's own share, which they absorb any leftover cent of", () => {
    // $100 four ways (3 payers + the requester): 2500 each.
    expect(splitShares({ totalCents: 10_000, payers: ["a", "b", "c"], requesterShares: true }).map((s) => s.amountCents)).toEqual([2500, 2500, 2500]);
    // $100 three ways: payers pay 3333 each; the requester's share covers the extra cent.
    expect(splitShares({ totalCents: 10_000, payers: ["a", "b"], requesterShares: true }).map((s) => s.amountCents)).toEqual([3333, 3333]);
  });

  it("spreads leftover cents over the first payers when the requester isn't sharing", () => {
    expect(splitShares({ totalCents: 10_000, payers: ["a", "b", "c"], requesterShares: false }).map((s) => s.amountCents)).toEqual([3334, 3333, 3333]);
  });

  it("never charges more than the total, in whole cents", () => {
    for (const total of [101, 999, 12_345, 100_001]) {
      for (const n of [1, 2, 3, 7]) {
        const payers = Array.from({ length: n }, (_, i) => `p${i}`);
        if (Math.floor(total / n) < MIN_SHARE_CENTS) {
          expect(() => splitShares({ totalCents: total, payers, requesterShares: false })).toThrow();
          continue;
        }
        const shares = splitShares({ totalCents: total, payers, requesterShares: false });
        expect(shares.reduce((a, s) => a + s.amountCents, 0)).toBe(total);
        expect(shares.every((s) => Number.isInteger(s.amountCents))).toBe(true);
      }
    }
  });

  it("rejects shares under $1 or over the cap, and empty payer lists", () => {
    expect(() => splitShares({ perPersonCents: MIN_SHARE_CENTS - 1, payers: ["a"] })).toThrow(/at least \$1/);
    expect(() => splitShares({ perPersonCents: MAX_SHARE_CENTS + 1, payers: ["a"] })).toThrow(/at most/);
    expect(() => splitShares({ totalCents: 250, payers: ["a", "b", "c"], requesterShares: true })).toThrow(/at least \$1/);
    expect(() => splitShares({ perPersonCents: 500, payers: [] })).toThrow(/at least one/);
    expect(() => splitShares({ perPersonCents: 10.5, payers: ["a"] })).toThrow(/whole cents/);
  });
});
