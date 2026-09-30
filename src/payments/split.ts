// Who pays how much in a collection. All money in integer cents.

import { money } from "../booking/shared";

export const MIN_SHARE_CENTS = 100;
/** A per-person cap so a typo can't hold $50,000 on someone's card. */
export const MAX_SHARE_CENTS = 500_000;

export class SplitError extends Error {}

export type SplitInput =
  | { perPersonCents: number; payers: string[] }
  /** A total shared evenly by the payers, plus the requester when requesterShares (who then absorbs any leftover cents). */
  | { totalCents: number; payers: string[]; requesterShares: boolean };

export function splitShares(input: SplitInput): Array<{ userId: string; amountCents: number }> {
  const { payers } = input;
  if (!payers.length) throw new SplitError("There has to be at least one person paying.");
  let amounts: number[];
  if ("perPersonCents" in input) {
    amounts = payers.map(() => input.perPersonCents);
  } else {
    const people = payers.length + (input.requesterShares ? 1 : 0);
    const base = Math.floor(input.totalCents / people);
    const leftover = input.totalCents - base * people;
    amounts = payers.map((_, i) => base + (!input.requesterShares && i < leftover ? 1 : 0));
  }
  for (const a of amounts) {
    if (!Number.isInteger(a)) throw new SplitError("Amounts must be whole cents.");
    if (a < MIN_SHARE_CENTS) throw new SplitError(`Each share has to be at least ${money(MIN_SHARE_CENTS)}.`);
    if (a > MAX_SHARE_CENTS) throw new SplitError(`Each share can be at most ${money(MAX_SHARE_CENTS)}.`);
  }
  return payers.map((userId, i) => ({ userId, amountCents: amounts[i]! }));
}
