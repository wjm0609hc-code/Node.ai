// Booking links with the party size and time (or stay dates) filled in, for
// platforms whose link parameters we know. Anything else is returned unchanged.
// TODO(verify against each platform's docs): parameter names below are from
// their public URLs, not official documentation.

export interface BookingDetails {
  partySize: number;
  /** Local date, YYYY-MM-DD (restaurants, activities). */
  date?: string;
  /** Local time, HH:MM. */
  time?: string;
  /** Stay dates, YYYY-MM-DD. */
  checkIn?: string;
  checkOut?: string;
}

export interface BookingLink {
  url: string;
  prefilled: boolean;
  platform?: string;
}

type Filler = { platform: string; match: RegExp; fill: (u: URL, d: BookingDetails) => boolean };

const set = (u: URL, entries: Record<string, string>) => {
  for (const [k, v] of Object.entries(entries)) u.searchParams.set(k, v);
};

const FILLERS: Filler[] = [
  {
    platform: "OpenTable",
    match: /(^|\.)opentable\.[a-z.]+$/,
    fill: (u, d) => !!(d.date && d.time) && (set(u, { covers: String(d.partySize), dateTime: `${d.date}T${d.time}` }), true),
  },
  {
    platform: "Resy",
    match: /(^|\.)resy\.com$/,
    fill: (u, d) => !!d.date && (set(u, { date: d.date, seats: String(d.partySize) }), true),
  },
  {
    platform: "Tock",
    match: /(^|\.)exploretock\.com$/,
    fill: (u, d) => {
      if (!(d.date && d.time)) return false;
      if (!/\/search\/?$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/$/, "")}/search`;
      set(u, { date: d.date, size: String(d.partySize), time: d.time });
      return true;
    },
  },
  {
    platform: "Airbnb",
    match: /(^|\.)airbnb\.[a-z.]+$/,
    fill: (u, d) => !!(d.checkIn && d.checkOut) && (set(u, { adults: String(d.partySize), check_in: d.checkIn, check_out: d.checkOut }), true),
  },
  {
    platform: "Vrbo",
    match: /(^|\.)vrbo\.com$/,
    fill: (u, d) => !!(d.checkIn && d.checkOut) && (set(u, { adults: String(d.partySize), startDate: d.checkIn, endDate: d.checkOut }), true),
  },
  {
    platform: "Booking.com",
    match: /(^|\.)booking\.com$/,
    fill: (u, d) =>
      !!(d.checkIn && d.checkOut) && (set(u, { checkin: d.checkIn, checkout: d.checkOut, group_adults: String(d.partySize) }), true),
  },
];

export function buildBookingLink(raw: string, details: BookingDetails): BookingLink {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not a web link");
  const filler = FILLERS.find((f) => f.match.test(u.hostname.toLowerCase()));
  if (!filler || !filler.fill(u, details)) return { url: raw, prefilled: false };
  u.searchParams.sort();
  return { url: u.toString(), prefilled: true, platform: filler.platform };
}
