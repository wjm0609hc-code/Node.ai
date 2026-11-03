import { describe, expect, it } from "vitest";
import { parseVenmoHandle, venmoPayLink } from "./venmo";

describe("parseVenmoHandle", () => {
  it.each([
    ["@patswarriors456", "patswarriors456"],
    ["patswarriors456", "patswarriors456"],
    ["https://venmo.com/u/patswarriors456", "patswarriors456"],
    ["venmo.com/patswarriors456", "patswarriors456"],
    ["https://account.venmo.com/u/Will-M_2", "Will-M_2"],
  ])("%s → %s", (raw, handle) => expect(parseVenmoHandle(raw)).toBe(handle));

  it.each(["", "abc", "not a handle!", "https://example.com/u/someone"])("rejects %j", (raw) => expect(parseVenmoHandle(raw)).toBeNull());
});

describe("venmoPayLink", () => {
  it("fills in the recipient, amount and note", () => {
    expect(venmoPayLink("patswarriors456", 38621, "Friday tab")).toBe("https://venmo.com/?txn=pay&recipients=patswarriors456&amount=386.21&note=Friday+tab");
  });
});
