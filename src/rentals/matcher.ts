// "Is this rental listed anywhere else?" Many rentals on Airbnb are also on Vrbo, Booking.com
// or Expedia, sometimes for less. A separate Claude call with web search looks for the same
// property using only the listing's own details (never the chat), and only returns places it
// actually found in that search.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AgentClient } from "../agent/responder";
import { extractJson } from "../search/picks";
import type { Listing, Price } from "./listing";

/** Sites Nod checks for the same property. */
export const CROSS_LIST_SITES = ["vrbo.com", "booking.com", "expedia.com", "hotels.com", "plumguide.com"];

export interface RentalMatchRequest {
  listing: Listing;
  url: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
}

export interface RentalMatch {
  url: string;
  site: string;
  title: string;
  price?: Price;
  photoUrl?: string;
  /** How the match was confirmed (same name, host, photos, address, layout). */
  evidence: string;
}

export type RentalMatcher = (req: RentalMatchRequest) => Promise<{ matches: RentalMatch[] }>;

export const noRentalMatcher: RentalMatcher = async () => {
  throw new Error("checking other sites isn't set up here");
};

const SYSTEM = `You check whether a vacation rental is also listed on other booking sites (${CROSS_LIST_SITES.join(", ")}).
Search for the SAME property: same name or host, same town or street, same layout (bedrooms, beds, baths, guests), matching photos or description. A similar place nearby is not a match.
Answer with ONLY a JSON object, no other text:
{"matches": [{"url": string, "title": string, "priceCents"?: integer, "currency"?: string, "per"?: "night" | "total", "photoUrl"?: string, "evidence": string}]}
Rules:
- Only listings you found in this search, on those sites. Never invent one.
- evidence: one short line on why it's the same place.
- Price only if the page or result showed it, for the dates given when there are dates; in the currency's minor unit (US cents).
- If you can't confirm the same property anywhere, return {"matches": []}.`;

const CURRENT_GEN = /^claude-(?:opus-5|fable-5|sonnet-5-5)/;

export function createClaudeRentalMatcher(opts: { client?: AgentClient; model?: string; timeoutMs?: number } = {}): RentalMatcher {
  let client = opts.client;
  const model = opts.model ?? process.env.NOD_SEARCH_MODEL ?? process.env.NOD_MODEL ?? "claude-opus-5-5";
  const current = CURRENT_GEN.test(model);
  return async (req) => {
    client ??= new Anthropic();
    const messages: BetaMessageParam[] = [{ role: "user", content: describeListing(req) }];
    const seen: string[] = [];
    let final: BetaContentBlock[] = [];
    for (let round = 0; round < 4; round++) {
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: 8000,
          system: SYSTEM,
          messages,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5, allowed_domains: CROSS_LIST_SITES }],
          ...(current ? { output_config: { effort: "low" as const }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { timeout: opts.timeoutMs ?? 90_000, maxRetries: 1 },
      );
      for (const b of response.content) collectUrls(b, seen);
      final = response.content;
      if (response.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: response.content });
    }
    const text = final.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    const parsed = extractJson(text) as { matches?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.matches)) throw new Error("couldn't read the comparison");
    return { matches: validateMatches(parsed.matches, seen, req.url) };
  };
}

function describeListing(r: RentalMatchRequest): string {
  const l = r.listing;
  return [
    `Listing: ${l.title ?? "(no title)"} on ${l.site ?? "a rental site"}`,
    l.location && `Where: ${l.location}`,
    [l.bedrooms && `${l.bedrooms} bedrooms`, l.beds && `${l.beds} beds`, l.baths && `${l.baths} baths`, l.sleeps && `sleeps ${l.sleeps}`].filter(Boolean).join(", "),
    r.checkIn && r.checkOut && `Dates: ${r.checkIn} to ${r.checkOut}`,
    r.guests && `Guests: ${r.guests}`,
    `Original listing: ${r.url}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function collectUrls(block: BetaContentBlock, into: string[]) {
  if (block.type !== "web_search_tool_result") return;
  const content = (block as { content: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const r of content) if (r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string") into.push((r as { url: string }).url);
}

function siteOf(host: string): string | null {
  const h = host.toLowerCase();
  return CROSS_LIST_SITES.find((s) => h === s || h.endsWith(`.${s}`)) ?? null;
}

const SITE_NAMES: Record<string, string> = { "vrbo.com": "Vrbo", "booking.com": "Booking.com", "expedia.com": "Expedia", "hotels.com": "Hotels.com", "plumguide.com": "Plum Guide" };

/**
 * Keeps only matches on the checked sites whose page appeared in this search's results (so
 * nothing is invented), with a plain title and a sane price. At most 3.
 */
export function validateMatches(raw: unknown[], seenUrls: string[], originalUrl: string): RentalMatch[] {
  const seenPages = new Set(seenUrls.map(pageKey).filter(Boolean));
  const out: RentalMatch[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if (typeof r.url !== "string" || typeof r.title !== "string" || typeof r.evidence !== "string") continue;
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    const site = siteOf(u.hostname);
    if (u.protocol !== "https:" || !site || !seenPages.has(pageKey(r.url)) || pageKey(r.url) === pageKey(originalUrl)) continue;
    const cents = typeof r.priceCents === "number" && Number.isInteger(r.priceCents) && r.priceCents > 0 && r.priceCents < 10_000_000 ? r.priceCents : undefined;
    const per = r.per === "night" || r.per === "total" ? r.per : undefined;
    const currency = typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency) ? r.currency : "USD";
    out.push({
      url: u.toString(),
      site: SITE_NAMES[site]!,
      title: r.title.slice(0, 120),
      evidence: r.evidence.slice(0, 200),
      ...(cents && per ? { price: { amountCents: cents, currency, per } } : {}),
      ...(typeof r.photoUrl === "string" && /^https:\/\//.test(r.photoUrl) ? { photoUrl: r.photoUrl } : {}),
    });
    if (out.length === 3) break;
  }
  return out;
}

function pageKey(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/** For the simulators: a labelled sample match, so the flow can be tried without the web. */
export const sampleRentalMatcher: RentalMatcher = async (req) => ({
  matches: [
    {
      url: "https://www.vrbo.com/0000000",
      site: "Vrbo",
      title: `${req.listing.title ?? "Same rental"} (sample match)`,
      evidence: "Sample: same name, layout and photos.",
      ...(req.listing.price ? { price: { ...req.listing.price, amountCents: Math.round(req.listing.price.amountCents * 0.9) } } : {}),
    },
  ],
});
