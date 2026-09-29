// Web search picks: the shape a searcher returns, validation against what the
// search actually found, and the one-line card.

import { shortLink } from "../rentals/listing";

export interface Pick {
  name: string;
  kind: "restaurant" | "activity" | "event" | "other";
  /** One short line: what it is. */
  summary: string;
  url: string;
  /** Hours, showtime or date, as found. */
  when?: string;
  /** "$$", "$40 per person", "free" — as found, never estimated. */
  priceHint?: string;
  address?: string;
  /** A reservation or ticket link, when the search found one. */
  bookingUrl?: string;
}

/** What the search sees: only the request, never the chat. */
export interface SearchRequest {
  query: string;
  location?: string;
  when?: string;
  partySize?: number;
  preferences?: string[];
}

export interface SearchResult {
  picks: Pick[];
}

export type Searcher = (request: SearchRequest) => Promise<SearchResult>;

export const noSearcher: Searcher = async () => {
  throw new Error("web search isn't set up here");
};

const KINDS = new Set(["restaurant", "activity", "event", "other"]);
export const MAX_PICKS = 8;

export function formatPickCard(p: Pick): string {
  return [p.name, p.summary, p.when, p.priceHint, shortLink(p.url)].filter((x) => x && String(x).trim()).join(" · ");
}

function httpUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const siteOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, "");
const text = (v: unknown, max = 160) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * Keeps picks that have a name and a web link on a site that appeared in this
 * search's results, so nothing invented or unverified reaches the group.
 */
export function validatePicks(raw: unknown[], seenUrls: string[], max = MAX_PICKS): Pick[] {
  const seenSites = new Set(seenUrls.map(httpUrl).filter((u): u is string => !!u).map(siteOf));
  const out: Pick[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = text(r.name, 80);
    const url = httpUrl(r.url);
    if (!name || !url || !seenSites.has(siteOf(url))) continue;
    const pick: Pick = { name, kind: KINDS.has(String(r.kind)) ? (r.kind as Pick["kind"]) : "other", summary: text(r.summary) ?? "", url };
    const when = text(r.when, 80);
    const priceHint = text(r.priceHint, 40);
    const address = text(r.address, 120);
    const bookingUrl = httpUrl(r.bookingUrl);
    if (when) pick.when = when;
    if (priceHint) pick.priceHint = priceHint;
    if (address) pick.address = address;
    if (bookingUrl && seenSites.has(siteOf(bookingUrl))) pick.bookingUrl = bookingUrl;
    out.push(pick);
    if (out.length >= max) break;
  }
  return out;
}

/** The first JSON value in a reply: the whole text, a fenced block, or the outermost braces. */
export function extractJson(reply: string): unknown {
  const candidates = [reply.trim(), /```(?:json)?\s*([\s\S]*?)```/i.exec(reply)?.[1]?.trim()];
  const first = reply.indexOf("{");
  const last = reply.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(reply.slice(first, last + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      // try the next form
    }
  }
  return null;
}
