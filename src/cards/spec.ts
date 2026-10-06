// What goes on a card for each kind of thing Nod shows: a rental, a search pick, a booking,
// a pay request. Pure functions, safe for the browser simulator.

import type { Option } from "../db/store";
import { formatPrice, type Price } from "../rentals/listing";
import type { CardData } from "./card";

/** A card to make: what's drawn, where the photo comes from, and where a tap goes. */
export interface CardSpec {
  data: Omit<CardData, "photo">;
  /** The product photo, when known. */
  photoUrl?: string;
  /** A page whose preview image is the photo, when the photo isn't known. */
  pageUrl?: string;
  /** Where tapping the card goes. */
  targetUrl: string;
}

const SOURCES: Array<[RegExp, string]> = [
  [/(^|\.)airbnb\.[a-z.]+$|(^|\.)abnb\.me$/, "Airbnb"],
  [/(^|\.)vrbo\.com$/, "Vrbo"],
  [/(^|\.)booking\.com$/, "Booking.com"],
  [/(^|\.)resy\.com$/, "Resy"],
  [/(^|\.)opentable\.[a-z.]+$/, "OpenTable"],
  [/(^|\.)exploretock\.com$/, "Tock"],
  [/(^|\.)sevenrooms\.com$/, "SevenRooms"],
  [/(^|\.)ticketmaster\.[a-z.]+$/, "Ticketmaster"],
  [/(^|\.)livenation\.com$/, "Live Nation"],
  [/(^|\.)seatgeek\.com$/, "SeatGeek"],
  [/(^|\.)stubhub\.[a-z.]+$/, "StubHub"],
  [/(^|\.)axs\.com$/, "AXS"],
  [/(^|\.)dice\.fm$/, "DICE"],
  [/(^|\.)eventbrite\.[a-z.]+$/, "Eventbrite"],
  [/(^|\.)viator\.com$/, "Viator"],
  [/(^|\.)getyourguide\.[a-z.]+$/, "GetYourGuide"],
  [/(^|\.)yelp\.[a-z.]+$/, "Yelp"],
  [/(^|\.)tripadvisor\.[a-z.]+$/, "Tripadvisor"],
  [/(^|\.)doordash\.com$/, "DoorDash"],
  [/(^|\.)ubereats\.com$/, "Uber Eats"],
  [/(^|\.)instacart\.com$/, "Instacart"],
];

/** "Resy", "Airbnb", or the site's own name from its address ("hartwoodtulum.com"). */
export function sourceName(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "Link";
  }
  for (const [re, name] of SOURCES) if (re.test(host)) return name;
  return host;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A card for a rental listing or a search pick saved as an option. Tapping it opens the listing or venue page. */
export function cardForOption(o: Pick<Option, "kind" | "url" | "parsed">, extra: { number?: number; details?: string; footer?: string; targetUrl?: string } = {}): CardSpec {
  const p = o.parsed;
  const title = str(p.title) ?? sourceName(o.url);
  const price = p.price ? formatPrice(p.price as Price) : str(p.priceHint);
  let details = extra.details;
  if (!details) {
    if (o.kind === "rental") {
      const rating = num(p.rating);
      const bits = [
        num(p.sleeps) ? `Sleeps ${num(p.sleeps)}` : undefined,
        num(p.bedrooms) ? `${num(p.bedrooms)} bedroom${num(p.bedrooms) === 1 ? "" : "s"}` : undefined,
        rating ? `★ ${rating.toFixed(2).replace(/0$/, "")}` : undefined,
      ].filter(Boolean);
      details = bits.length ? bits.join(" · ") : str(p.location);
    } else {
      details = [str(p.when), str(p.summary)].filter(Boolean).join(" · ") || str(p.address);
    }
  }
  return {
    data: {
      ...(extra.number !== undefined ? { number: extra.number } : {}),
      source: str(p.site) ?? sourceName(o.url),
      title,
      ...(price ? { price } : {}),
      ...(details ? { details } : {}),
      ...(extra.footer ?? str(p.bookingFooter) ?? str(p.location) ? { footer: extra.footer ?? str(p.bookingFooter) ?? str(p.location) } : {}),
      ...(str(p.bookingLabel) && !extra.targetUrl ? { linkLabel: str(p.bookingLabel) } : {}),
    },
    ...(str(p.photoUrl) ? { photoUrl: str(p.photoUrl) } : { pageUrl: o.url }),
    // A reservation page found by a search (with the party size and time filled in) beats the venue's own page.
    targetUrl: extra.targetUrl ?? str(p.bookingLink) ?? o.url,
  };
}
