// Spending rules for bookings Nod makes itself (CLAUDE.md rule 4): who has to
// approve before Nod books something that charges a deposit. Pure functions.
// Step 14 adds a way for groups to change these; until then every group uses the defaults.

import type { ProposalTerms } from "../db/store";

export interface SpendRules {
  /** Who approves spending within the per-person limit. */
  approver: "organizer" | "anyone";
  /** Above this per person, several people must approve. Integer cents. */
  perPersonLimitCents: number;
  approvalsOverLimit: number;
}

export const DEFAULT_SPEND_RULES: SpendRules = { approver: "organizer", perPersonLimitCents: 20_000, approvalsOverLimit: 3 };

export type ApprovalRequirement = ProposalTerms["approval"];

const wholeAtLeast = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;

/** A group's stored spend_rules, with defaults for anything missing or invalid. */
export function readSpendRules(json: unknown): SpendRules {
  const r = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  return {
    approver: r.approver === "anyone" || r.approver === "organizer" ? r.approver : DEFAULT_SPEND_RULES.approver,
    perPersonLimitCents: wholeAtLeast(r.perPersonLimitCents, 0) ? r.perPersonLimitCents : DEFAULT_SPEND_RULES.perPersonLimitCents,
    approvalsOverLimit: wholeAtLeast(r.approvalsOverLimit, 1) ? r.approvalsOverLimit : DEFAULT_SPEND_RULES.approvalsOverLimit,
  };
}

export function approvalRequirement(args: {
  rules: SpendRules;
  depositCents: number;
  partySize: number;
  organizerUserId: string | null;
  addedByUserId: string | null;
  requesterUserId: string;
  memberIds: string[];
}): ApprovalRequirement {
  const perPerson = Math.ceil(args.depositCents / Math.max(1, args.partySize));
  if (perPerson > args.rules.perPersonLimitCents) {
    return { kind: "count", count: Math.max(1, Math.min(args.rules.approvalsOverLimit, args.memberIds.length)) };
  }
  // Nothing charged: any one member confirming the exact terms is enough.
  if (args.depositCents === 0 || args.rules.approver === "anyone") return { kind: "count", count: 1 };
  // The organizer approves. Groups don't name one yet, so fall back to whoever added Nod, then the requester.
  const inGroup = (id: string | null): id is string => !!id && args.memberIds.includes(id);
  const approver = [args.organizerUserId, args.addedByUserId, args.requesterUserId].find(inGroup) ?? args.requesterUserId;
  return { kind: "one_of", userIds: [approver] };
}

export function isApproved(req: ApprovalRequirement, approvals: string[], memberIds: string[]): boolean {
  if (req.kind === "one_of") return approvals.some((id) => req.userIds.includes(id));
  return new Set(approvals.filter((id) => memberIds.includes(id))).size >= req.count;
}
