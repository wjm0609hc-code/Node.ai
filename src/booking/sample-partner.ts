// A stand-in booking partner for the simulators and tests: made-up availability,
// deposits and confirmation codes, all labelled as samples. It never runs in
// production (src/server/container.ts passes no partners until real ones exist).

import type { Option } from "../db/store";
import { localDateTimeToUtc } from "../lib/time";
import { SlotUnavailableError, type BookingPartner, type PartnerBooking, type Slot } from "./partners";

const HOUR = 3_600_000;
const HOSTS = ["resy.com", "opentable.com", "exploretock.com"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export interface SamplePartnerOptions {
  /** Times (local "HH:MM") that are always taken, for tests. Otherwise about one in four is. */
  taken?: string[];
  /** Total deposit for a party, in cents. Default: $25 a person for parties of 6 or more. */
  deposit?: (partySize: number) => number;
  now?: () => Date;
}

export function createSamplePartner(opts: SamplePartnerOptions = {}): BookingPartner {
  const booked = new Map<string, { booking: PartnerBooking; slot: Slot }>();
  const takenBy = new Set<string>();
  const isTaken = (venueId: string, date: string, time: string) =>
    takenBy.has(`${venueId}|${date}|${time}`) ||
    (opts.taken ? opts.taken.includes(time) : hash(`${venueId}|${date}|${time}`) % 4 === 0);

  function slotFor(venueId: string, partySize: number, date: string, time: string, tz: string): Slot | null {
    const startsAt = localDateTimeToUtc(`${date}T${time}`, tz);
    if (!startsAt) return null;
    const depositCents = opts.deposit ? opts.deposit(partySize) : partySize >= 6 ? 2500 * partySize : 0;
    return {
      id: `${date}T${time}`,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * HOUR),
      depositCents,
      currency: "USD",
      freeCancelUntil: new Date(startsAt.getTime() - 24 * HOUR),
      cancelFeeCents: depositCents,
      policy: depositCents
        ? "Sample policy: free cancellation until 24 hours before; after that the deposit is kept."
        : "Sample policy: free cancellation until 24 hours before.",
    };
  }

  return {
    id: "sample",
    name: "Sample Reservations",
    async venueFor(option: Option) {
      if (option.kind !== "restaurant" && option.kind !== "activity" && option.kind !== "event") return null;
      const url = typeof option.parsed.bookingUrl === "string" ? option.parsed.bookingUrl : option.url;
      const host = hostOf(url);
      const ok = HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || url.startsWith("https://example.com/sample/");
      return ok ? url : null;
    },
    async availability({ venueId, partySize, date, time, timezone }) {
      const [h, m] = time.split(":").map(Number) as [number, number];
      const asked = h * 60 + m;
      const out: Array<{ slot: Slot; distance: number }> = [];
      for (let t = 17 * 60; t <= 22 * 60 + 30; t += 15) {
        const hhmm = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
        if (Math.abs(t - asked) > 90 || isTaken(venueId, date, hhmm)) continue;
        const slot = slotFor(venueId, partySize, date, hhmm, timezone);
        if (slot) out.push({ slot, distance: Math.abs(t - asked) });
      }
      return out.sort((a, b) => a.distance - b.distance || a.slot.startsAt.getTime() - b.slot.startsAt.getTime()).map((x) => x.slot);
    },
    async book({ venueId, slot, idempotencyKey }) {
      const seen = booked.get(idempotencyKey);
      if (seen) return seen.booking;
      const [date, time] = slot.id.split("T") as [string, string];
      if (isTaken(venueId, date, time)) throw new SlotUnavailableError();
      takenBy.add(`${venueId}|${date}|${time}`);
      const code = `SAMPLE-${hash(idempotencyKey).toString(36).toUpperCase().slice(0, 5)}`;
      const booking: PartnerBooking = { partnerBookingId: `sample_${hash(idempotencyKey)}`, confirmationCode: code };
      booked.set(idempotencyKey, { booking, slot });
      return booking;
    },
    async cancel({ venueId, partnerBookingId }) {
      for (const [key, b] of booked) {
        if (b.booking.partnerBookingId !== partnerBookingId) continue;
        booked.delete(key);
        const [date, time] = b.slot.id.split("T") as [string, string];
        takenBy.delete(`${venueId}|${date}|${time}`);
        const late = b.slot.freeCancelUntil && (opts.now?.() ?? new Date()).getTime() > b.slot.freeCancelUntil.getTime();
        return { feeCents: late ? b.slot.cancelFeeCents : 0 };
      }
      return { feeCents: 0 };
    },
  };
}
