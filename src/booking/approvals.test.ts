import { describe, expect, it } from "vitest";
import { approvalRequirement, isApproved, readSpendRules } from "./approvals";

const members = ["will", "sarah", "jake", "mike"];
const base = { rules: readSpendRules({}), partySize: 4, organizerUserId: "sarah", addedByUserId: "will", requesterUserId: "jake", memberIds: members };

describe("readSpendRules", () => {
  it("defaults to the organizer approving, and three approvals over $200 per person", () => {
    expect(readSpendRules({})).toEqual({ approver: "organizer", perPersonLimitCents: 20000, approvalsOverLimit: 3 });
    expect(readSpendRules(null)).toEqual(readSpendRules({}));
  });

  it("takes valid overrides and ignores bad values", () => {
    expect(readSpendRules({ approver: "anyone", perPersonLimitCents: 5000, approvalsOverLimit: 2 })).toEqual({
      approver: "anyone", perPersonLimitCents: 5000, approvalsOverLimit: 2,
    });
    expect(readSpendRules({ approver: "boss", perPersonLimitCents: -1, approvalsOverLimit: 0.5 })).toEqual(readSpendRules({}));
  });
});

describe("approvalRequirement", () => {
  it("needs the organizer for a deposit within the limit", () => {
    expect(approvalRequirement({ ...base, depositCents: 8000 })).toEqual({ kind: "one_of", userIds: ["sarah"] });
  });

  it("falls back to whoever added Nod, then the requester, when no organizer is set", () => {
    expect(approvalRequirement({ ...base, organizerUserId: null, depositCents: 8000 })).toEqual({ kind: "one_of", userIds: ["will"] });
    expect(approvalRequirement({ ...base, organizerUserId: null, addedByUserId: null, depositCents: 8000 })).toEqual({ kind: "one_of", userIds: ["jake"] });
    // Someone no longer in the group can't approve.
    expect(approvalRequirement({ ...base, organizerUserId: "gone", depositCents: 8000 })).toEqual({ kind: "one_of", userIds: ["will"] });
  });

  it("needs three people when it's over $200 per person", () => {
    expect(approvalRequirement({ ...base, depositCents: 80_004 })).toEqual({ kind: "count", count: 3 });
    // Exactly $200 each is within the limit.
    expect(approvalRequirement({ ...base, depositCents: 80_000 })).toEqual({ kind: "one_of", userIds: ["sarah"] });
  });

  it("never asks for more approvals than there are members", () => {
    expect(approvalRequirement({ ...base, memberIds: ["will", "sarah"], depositCents: 100_000 })).toEqual({ kind: "count", count: 2 });
  });

  it("lets any one member confirm when nothing is charged", () => {
    expect(approvalRequirement({ ...base, depositCents: 0 })).toEqual({ kind: "count", count: 1 });
  });

  it("lets anyone approve within the limit when the group's rules say so", () => {
    expect(approvalRequirement({ ...base, rules: readSpendRules({ approver: "anyone" }), depositCents: 8000 })).toEqual({ kind: "count", count: 1 });
  });
});

describe("isApproved", () => {
  it("one_of: any listed person", () => {
    const req = { kind: "one_of" as const, userIds: ["sarah"] };
    expect(isApproved(req, [], members)).toBe(false);
    expect(isApproved(req, ["jake", "mike"], members)).toBe(false);
    expect(isApproved(req, ["jake", "sarah"], members)).toBe(true);
  });

  it("count: distinct current members only", () => {
    const req = { kind: "count" as const, count: 3 };
    expect(isApproved(req, ["will", "will", "jake"], members)).toBe(false);
    expect(isApproved(req, ["will", "jake", "ex-member"], members)).toBe(false);
    expect(isApproved(req, ["will", "jake", "mike"], members)).toBe(true);
  });
});
