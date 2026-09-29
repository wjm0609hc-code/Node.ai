// How an option (a rental link or a search pick) is named in votes and results.

import type { Option } from "../db/store";
import { formatPrice, shortLink, type Price } from "../rentals/listing";

/** The option's name, or its short link when Nod hasn't read it. */
export function optionLabel(o: Option): string {
  const title = typeof o.parsed.title === "string" ? o.parsed.title : undefined;
  return title ?? shortLink(o.url);
}

/** A compact line for a vote: name, price, short link. */
export function optionLine(o: Option): string {
  const title = typeof o.parsed.title === "string" ? o.parsed.title : undefined;
  const price = o.parsed.price ? formatPrice(o.parsed.price as Price) : typeof o.parsed.priceHint === "string" ? o.parsed.priceHint : undefined;
  return [title, price, shortLink(o.url)].filter(Boolean).join(" · ");
}
