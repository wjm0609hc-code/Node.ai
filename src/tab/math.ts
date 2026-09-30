// The tab's arithmetic, in integer cents. Pure functions: every split adds up to
// its total exactly, and settling up clears every balance.

import { money } from "../booking/shared";
import type { ParsedReceipt } from "../db/store";

export class TabMathError extends Error {}

export interface Share {
  userId: string;
  amountCents: number;
}

export interface Transfer {
  from: string;
  to: string;
  amountCents: number;
}

/** Settle-up payments under this are skipped (card payments have a minimum). */
export const MIN_TRANSFER_CENTS = 100;

function checkTotal(total: number): void {
  if (!Number.isInteger(total) || total <= 0) throw new TabMathError("The amount has to be a positive number of whole cents.");
}

/** Largest-remainder rounding: splits `total` in proportion to `weights`, adding up exactly. */
function apportion(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((a, w) => a + w, 0);
  if (sumW <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sumW);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, v) => a + v, 0);
  // Fractions compared at 1e-9 so floating-point noise never decides who gets a cent; ties go to the earlier person.
  const order = raw.map((r, i) => ({ i, frac: Math.round((r - Math.floor(r)) * 1e9) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length]!.i]!++;
  return out;
}

export function equalSplit(totalCents: number, people: string[]): Share[] {
  checkTotal(totalCents);
  const unique = [...new Set(people)];
  if (!unique.length) throw new TabMathError("Say who it's split between.");
  const amounts = apportion(totalCents, unique.map(() => 1));
  return unique.map((userId, i) => ({ userId, amountCents: amounts[i]! }));
}

export function exactSplit(totalCents: number, shares: Share[]): Share[] {
  checkTotal(totalCents);
  if (shares.some((s) => !Number.isInteger(s.amountCents) || s.amountCents < 0)) throw new TabMathError("Each share has to be zero or more, in whole cents.");
  const sum = shares.reduce((a, s) => a + s.amountCents, 0);
  if (sum !== totalCents) throw new TabMathError(`Those shares add up to ${money(sum)}, not ${money(totalCents)}.`);
  const merged = new Map<string, number>();
  for (const s of shares) merged.set(s.userId, (merged.get(s.userId) ?? 0) + s.amountCents);
  return [...merged].filter(([, c]) => c > 0).map(([userId, amountCents]) => ({ userId, amountCents }));
}

/**
 * Splits a receipt: each assigned item goes to its people (evenly), unassigned items are shared by `everyone`,
 * and tax, tip and fees are spread in proportion to what each person had. Items are numbered from 1.
 */
export function receiptSplit(receipt: ParsedReceipt, assignments: Array<{ item: number; people: string[] }>, everyone: string[]): Share[] {
  checkTotal(receipt.totalCents);
  const all = [...new Set(everyone)];
  if (!all.length) throw new TabMathError("Say who it's split between.");
  const owners = new Map<number, string[]>();
  for (const a of assignments) {
    if (!Number.isInteger(a.item) || a.item < 1 || a.item > receipt.items.length) throw new TabMathError(`There's no item ${a.item} on this receipt.`);
    const people = [...new Set(a.people)];
    if (!people.length) throw new TabMathError(`Say who had item ${a.item}.`);
    owners.set(a.item, people);
  }
  // Each person's item subtotal, in exact fractions of a cent (scaled to avoid rounding until the end).
  const people = [...new Set([...all, ...[...owners.values()].flat()])];
  const itemShare = new Map(people.map((p) => [p, 0]));
  receipt.items.forEach((item, idx) => {
    const who = owners.get(idx + 1) ?? all;
    for (const p of who) itemShare.set(p, itemShare.get(p)! + item.cents / who.length);
  });
  const amounts = apportion(receipt.totalCents, people.map((p) => itemShare.get(p)!));
  return people.map((userId, i) => ({ userId, amountCents: amounts[i]! })).filter((s) => s.amountCents > 0);
}

/** What each person is owed (positive) or owes (negative), from the tab's entries. */
export function balances(entries: Array<{ payerUserId: string; amountCents: number; shares: Share[] }>): Map<string, number> {
  const b = new Map<string, number>();
  for (const e of entries) {
    b.set(e.payerUserId, (b.get(e.payerUserId) ?? 0) + e.amountCents);
    for (const s of e.shares) b.set(s.userId, (b.get(s.userId) ?? 0) - s.amountCents);
  }
  return b;
}

/** Payments that clear the balances: the biggest debtor pays the biggest creditor, repeatedly (at most n - 1 payments). */
export function settleTransfers(b: Map<string, number>, minCents = MIN_TRANSFER_CENTS): Transfer[] {
  const creditors = [...b].filter(([, v]) => v > 0).map(([id, v]) => ({ id, v }));
  const debtors = [...b].filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v }));
  const out: Transfer[] = [];
  const byAmount = (x: { id: string; v: number }, y: { id: string; v: number }) => y.v - x.v || x.id.localeCompare(y.id);
  for (;;) {
    creditors.sort(byAmount);
    debtors.sort(byAmount);
    const c = creditors[0];
    const d = debtors[0];
    if (!c || !d || c.v === 0 || d.v === 0) break;
    const amount = Math.min(c.v, d.v);
    out.push({ from: d.id, to: c.id, amountCents: amount });
    c.v -= amount;
    d.v -= amount;
  }
  return out.filter((t) => t.amountCents >= minCents);
}
