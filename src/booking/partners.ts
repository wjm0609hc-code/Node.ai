// Booking partners: reservation platforms Nod can book through directly
// (OpenTable, Resy, Tock, Viator, ...). Each partner is an adapter behind this
// interface, so adding one never touches the approval and booking flow in
// booking.ts. Venues no partner covers fall back to the booking-link hand-off.
//
// Adapters make their HTTP calls through src/lib/http.ts (timeouts, retries) and
// pass `idempotencyKey` to the partner, so a retried book() never books twice.
// Deposits and prepayments are charged by the partner or venue directly; Nod
// never holds the money (rule 5).

import type { Option } from "../db/store";

export interface Slot {
  /** The partner's id for this time, passed back to book(). */
  id: string;
  startsAt: Date;
  endsAt: Date;
  /** Total deposit or prepayment for the party, in integer cents; 0 for none. */
  depositCents: number;
  currency: string;
  /** Free cancellation until this time; null if cancelling is never free. */
  freeCancelUntil: Date | null;
  /** What cancelling after the free window costs, in cents. */
  cancelFeeCents: number;
  /** The venue's policy in its own words, for the full details. */
  policy: string;
}

export interface PartnerBooking {
  partnerBookingId: string;
  confirmationCode: string;
  /** Where the guest can view or change the booking. */
  manageUrl?: string;
  /** Set when the partner needs the guest to pay the deposit themselves (sent to them privately). */
  depositPayUrl?: string;
}

export interface AvailabilityQuery {
  venueId: string;
  partySize: number;
  /** Local date and time asked about, in the venue's timezone: "2026-10-03", "20:00". */
  date: string;
  time: string;
  timezone: string;
}

export interface BookingPartner {
  id: string;
  /** Shown to people: "OpenTable". */
  name: string;
  /** The partner's venue id for an option, or null if this partner can't book it. */
  venueFor(option: Option): Promise<string | null>;
  /** Open times around the requested one, for this party size. */
  availability(q: AvailabilityQuery): Promise<Slot[]>;
  /** Books a slot. Throws SlotUnavailableError if it was taken in the meantime. */
  book(r: { venueId: string; slot: Slot; partySize: number; guest: { name: string; phone: string }; idempotencyKey: string }): Promise<PartnerBooking>;
  /** Cancels with the venue; returns the fee charged, in cents. */
  cancel(r: { venueId: string; partnerBookingId: string; idempotencyKey: string }): Promise<{ feeCents: number }>;
}

export class SlotUnavailableError extends Error {
  constructor() {
    super("slot no longer available");
    this.name = "SlotUnavailableError";
  }
}

/** The first partner that can book this option. */
export async function partnerFor(partners: BookingPartner[], option: Option): Promise<{ partner: BookingPartner; venueId: string } | null> {
  if (option.kind === "rental") return null; // stays go through links (there's no Airbnb booking API)
  for (const partner of partners) {
    const venueId = await partner.venueFor(option);
    if (venueId) return { partner, venueId };
  }
  return null;
}
