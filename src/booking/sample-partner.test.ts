import { describe, expect, it } from "vitest";
import type { Option } from "../db/store";
import { SlotUnavailableError } from "./partners";
import { createSamplePartner } from "./sample-partner";

const option = (over: Partial<Option>): Option =>
  ({ id: "o1", groupId: "g", kind: "restaurant", source: "search", url: "https://hartwood.test/", parsed: {}, ...over }) as Option;
const q = { venueId: "v", partySize: 6, date: "2026-10-03", time: "20:00", timezone: "America/New_York" };

describe("sample partner", () => {
  it("covers restaurants on reservation sites and the simulator's sample picks, never rentals", async () => {
    const p = createSamplePartner();
    expect(await p.venueFor(option({ parsed: { bookingUrl: "https://resy.com/cities/tulum/venues/hartwood" } }))).toBeTruthy();
    expect(await p.venueFor(option({ url: "https://example.com/sample/woodfire" }))).toBeTruthy();
    expect(await p.venueFor(option({}))).toBeNull();
    expect(await p.venueFor(option({ kind: "rental", url: "https://www.opentable.com/r/x" }))).toBeNull();
  });

  it("offers nearby times, closest first, with a deposit for parties of 6 or more", async () => {
    const p = createSamplePartner({ taken: ["20:00"] });
    const slots = await p.availability(q);
    expect(slots.map((s) => s.id).slice(0, 2)).toEqual(["2026-10-03T19:45", "2026-10-03T20:15"]);
    expect(slots[0]).toMatchObject({ depositCents: 15000, currency: "USD", cancelFeeCents: 15000 });
    expect(slots[0]!.freeCancelUntil!.toISOString()).toBe("2026-10-02T23:45:00.000Z");
    expect((await p.availability({ ...q, partySize: 2 }))[0]!.depositCents).toBe(0);
  });

  it("books once per idempotency key, and a booked time is then taken", async () => {
    const p = createSamplePartner({ taken: [] });
    const [slot] = await p.availability(q);
    const args = { venueId: "v", slot: slot!, partySize: 6, guest: { name: "Will", phone: "+1555" }, idempotencyKey: "b1" };
    const first = await p.book(args);
    expect(first.confirmationCode).toMatch(/^SAMPLE-/);
    expect(await p.book(args)).toEqual(first);
    await expect(p.book({ ...args, idempotencyKey: "b2" })).rejects.toBeInstanceOf(SlotUnavailableError);
    expect((await p.availability(q)).some((s) => s.id === slot!.id)).toBe(false);
  });

  it("charges the fee only after free cancellation ends", async () => {
    let now = new Date("2026-10-01T12:00:00Z");
    const p = createSamplePartner({ taken: [], now: () => now });
    const [slot] = await p.availability(q);
    const a = await p.book({ venueId: "v", slot: slot!, partySize: 6, guest: { name: "W", phone: "+1" }, idempotencyKey: "a" });
    expect(await p.cancel({ venueId: "v", partnerBookingId: a.partnerBookingId, idempotencyKey: "a:c" })).toEqual({ feeCents: 0 });
    const b = await p.book({ venueId: "v", slot: slot!, partySize: 6, guest: { name: "W", phone: "+1" }, idempotencyKey: "b" });
    now = new Date("2026-10-03T12:00:00Z");
    expect(await p.cancel({ venueId: "v", partnerBookingId: b.partnerBookingId, idempotencyKey: "b:c" })).toEqual({ feeCents: 15000 });
  });
});
