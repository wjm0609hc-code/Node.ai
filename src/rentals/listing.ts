// Reading a rental listing from its link preview (Open Graph tags, schema.org
// JSON-LD, <title>, description), plus URL clean-up and the one-line card.

export interface Price {
  /** Integer cents (or the currency's minor unit). */
  amountCents: number;
  currency: string;
  per: "night" | "total";
}

export interface Listing {
  title?: string;
  photoUrl?: string;
  site?: string;
  location?: string;
  price?: Price;
  sleeps?: number;
  bedrooms?: number;
  beds?: number;
  baths?: number;
  rating?: number;
  cancellation?: string;
}

const SITES: Array<[RegExp, string]> = [
  [/(^|\.)airbnb\.[a-z.]+$|(^|\.)abnb\.me$/, "Airbnb"],
  [/(^|\.)vrbo\.com$/, "Vrbo"],
  [/(^|\.)booking\.com$/, "Booking.com"],
  [/(^|\.)plumguide\.com$/, "Plum Guide"],
  [/(^|\.)homeaway\.[a-z.]+$/, "HomeAway"],
  [/(^|\.)hometogo\.[a-z.]+$/, "HomeToGo"],
  [/(^|\.)sonder\.com$/, "Sonder"],
];

/** Links to rental listings on known sites. Other links are only read when someone asks Nod about them. */
export function isRentalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (/(^|\.)airbnb\.[a-z.]+$/.test(host)) return /^\/(rooms|h|luxury\/listing)\//.test(path);
  if (/(^|\.)abnb\.me$/.test(host)) return true;
  if (/(^|\.)vrbo\.com$/.test(host)) return /^\/(\d|[a-z-]+\/p\d)/i.test(path.slice(0, 20)) || /\/\d+/.test(path);
  if (/(^|\.)booking\.com$/.test(host)) return path.startsWith("/hotel/");
  if (/(^|\.)plumguide\.com$/.test(host)) return path.startsWith("/homes/");
  return SITES.slice(4).some(([re]) => re.test(host));
}

const TRACKING = /^(utm_|fbclid$|gclid$|igshid$|mc_|ref$|source_impression_id$|previous_page_section_name$|federated_search_id$|s$|unique_share_id$|wishlist)/i;

/** Canonical https URL without tracking params or fragments; keeps dates and guest counts. Null for non-web links. */
export function normalizeListingUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.protocol = "https:";
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (/^airbnb\.[a-z.]+$/.test(url.hostname) || /^vrbo\.com$/.test(url.hostname)) url.hostname = `www.${url.hostname}`;
  const kept = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [k, v] of kept) url.searchParams.append(k, v);
  return url.toString();
}

export function siteName(raw: string): string | undefined {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return SITES.find(([re]) => re.test(host))?.[1] ?? host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function parseListingHtml(url: string, html: string): Listing {
  const meta = readMeta(html);
  const ld = readJsonLd(html);
  const out: Listing = {};
  const site = siteName(url);
  if (site) out.site = site;

  // Airbnb-style titles: "Casa Azul · Condo in Tulum · ★4.92 · 2 bedrooms · 3 beds · 2 baths"
  const rawTitle = meta["og:title"] ?? meta["twitter:title"] ?? readTitle(html);
  const namedParts: string[] = [];
  let typeTitle: string | undefined;
  for (const part of (rawTitle ?? "").split(/\s+·\s+/)) {
    const p = part.trim();
    if (!p) continue;
    const inPlace = /^([A-Za-z ]{2,30}) in (.+)$/.exec(p);
    const rating = /^★\s*([\d.]+)/.exec(p);
    if (rating) out.rating = Number(rating[1]);
    else if (inPlace) {
      out.location ??= inPlace[2]!.trim();
      typeTitle = p;
    } else if (/^\d+(\.\d+)?\s+(bedrooms?|beds?|baths?|bathrooms?|guests?)$/i.test(p) || /^studio$/i.test(p)) countsFrom(p, out);
    else namedParts.push(p);
  }
  const title = cleanTitle(ld.name ?? namedParts[0] ?? typeTitle, site); // structured data first
  if (title) out.title = title;

  const photo = meta["og:image"] ?? meta["twitter:image"] ?? ld.image;
  if (photo && /^https?:\/\//.test(photo)) out.photoUrl = photo;

  if (ld.location) out.location ??= ld.location;
  if (ld.sleeps) out.sleeps = ld.sleeps;
  if (ld.bedrooms) out.bedrooms ??= ld.bedrooms;
  if (ld.baths) out.baths ??= ld.baths;
  if (ld.rating) out.rating ??= ld.rating;
  if (ld.price) out.price = ld.price;

  const text = [meta["og:description"], meta["description"], meta["twitter:description"]].filter(Boolean).join(" ");
  countsFrom(text, out);
  const sleeps = /sleeps\s+(\d+)|(\d+)\s+guests?/i.exec(text);
  if (sleeps) out.sleeps ??= Number(sleeps[1] ?? sleeps[2]);
  out.price ??= priceFrom(text);
  const cancel = /(free cancellation[^.!,;]*|non-refundable|no refunds?|flexible cancellation[^.!,;]*|moderate cancellation[^.!,;]*|strict cancellation[^.!,;]*)/i.exec(text);
  if (cancel) out.cancellation = capitalize(cancel[1]!.trim());
  return out;
}

function countsFrom(text: string, out: Listing) {
  const n = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : undefined;
  };
  out.bedrooms ??= n(/(\d+)[\s-]+bedrooms?\b/i) ?? (/\bstudio\b/i.test(text) ? 0 : undefined);
  out.beds ??= n(/(\d+)\s+beds?\b/i);
  out.baths ??= n(/(\d+(?:\.\d+)?)\s+(?:baths?|bathrooms?)\b/i);
  if (out.bedrooms === undefined) delete out.bedrooms;
  if (out.beds === undefined) delete out.beds;
  if (out.baths === undefined) delete out.baths;
}

const CURRENCY: Array<[RegExp, string]> = [
  [/MX\$|MXN/i, "MXN"],
  [/CA\$|CAD/i, "CAD"],
  [/A\$|AUD/i, "AUD"],
  [/€|EUR/i, "EUR"],
  [/£|GBP/i, "GBP"],
  [/\$|USD/i, "USD"],
];

function priceFrom(text: string): Price | undefined {
  const m = /((?:MX|CA|A|US)?\$|€|£|\b(?:USD|MXN|EUR|GBP|CAD|AUD)\s?)\s?([\d,]+(?:\.\d{1,2})?)\s*(?:\/\s*|per\s+|a\s+)?(night|nightly|total)?/i.exec(text);
  if (!m || !m[3]) return undefined;
  const currency = CURRENCY.find(([re]) => re.test(m[1]!))?.[1] ?? "USD";
  return { amountCents: toCents(m[2]!), currency, per: /total/i.test(m[3]) ? "total" : "night" };
}

function toCents(amount: string): number {
  const [whole, frac = ""] = amount.replace(/,/g, "").split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}

function readMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (key && content && !(key in out)) out[key] = decodeEntities((content[1] ?? content[2] ?? "").trim());
  }
  return out;
}

function readTitle(html: string): string | undefined {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return t ? decodeEntities(t.trim()) : undefined;
}

interface LdFacts {
  name?: string;
  image?: string;
  location?: string;
  sleeps?: number;
  bedrooms?: number;
  baths?: number;
  rating?: number;
  price?: Price;
}

function readJsonLd(html: string): LdFacts {
  const facts: LdFacts = {};
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, ""));
    } catch {
      continue;
    }
    for (const node of flatten(data)) {
      const type = String(node["@type"] ?? "");
      if (!/Rental|Lodging|Accommodation|House|Apartment|Hotel|Product|Place|Residence/i.test(type)) continue;
      facts.name ??= str(node.name);
      facts.image ??= str(Array.isArray(node.image) ? node.image[0] : node.image);
      const addr = node.address as Record<string, unknown> | undefined;
      facts.location ??= str(addr?.addressLocality);
      const acc = (node.containsPlace as Record<string, unknown>) ?? node;
      facts.sleeps ??= num((acc.occupancy as Record<string, unknown>)?.maxValue);
      facts.bedrooms ??= num(acc.numberOfBedrooms ?? node.numberOfRooms);
      facts.baths ??= num(acc.numberOfBathroomsTotal);
      facts.rating ??= num((node.aggregateRating as Record<string, unknown>)?.ratingValue);
      const offer = (Array.isArray(node.offers) ? node.offers[0] : node.offers) as Record<string, unknown> | undefined;
      const amount = offer && (str(offer.price) ?? (typeof offer.price === "number" ? String(offer.price) : undefined));
      if (amount && !facts.price && /^\d+(\.\d+)?$/.test(amount)) {
        facts.price = {
          amountCents: toCents(amount),
          currency: str(offer!.priceCurrency) ?? "USD",
          per: /total|stay/i.test(str(offer!.unitText) ?? "") ? "total" : "night",
        };
      }
    }
  }
  return facts;
}

function flatten(data: unknown): Array<Record<string, any>> {
  if (Array.isArray(data)) return data.flatMap(flatten);
  if (data && typeof data === "object") {
    const obj = data as Record<string, any>;
    return [obj, ...(obj["@graph"] ? flatten(obj["@graph"]) : [])];
  }
  return [];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? decodeEntities(v.trim()) : undefined);
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

function cleanTitle(title: string | undefined, site: string | undefined): string | undefined {
  if (!title) return undefined;
  let t = title.replace(/\s*[-|–]\s*(Airbnb|Vrbo|Booking\.com|Plum Guide)\s*$/i, "");
  if (!site || !["Airbnb", "Vrbo", "Booking.com"].includes(site)) t = t.split(/\s+[|–-]\s+/)[0]!;
  return t.trim() || undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- cards ----

export function formatPrice(p: Price): string {
  const whole = p.amountCents % 100 === 0;
  const n = (p.amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  const amount = p.currency === "USD" ? `$${n}` : `${p.currency} ${n}`;
  return p.per === "night" ? `${amount}/night` : `${amount} total`;
}

/** One short line: name, place, price, size, rating, cancellation, short link. */
export function formatRentalCard(l: Listing, url: string): string {
  const parts = [
    l.title ? (l.location ? `${l.title}, ${l.location}` : l.title) : undefined,
    l.price ? formatPrice(l.price) : undefined,
    l.sleeps !== undefined ? `sleeps ${l.sleeps}` : undefined,
    l.bedrooms !== undefined ? (l.bedrooms === 0 ? "studio" : `${l.bedrooms} BR`) : undefined,
    l.rating !== undefined ? `★${l.rating}` : undefined,
    l.cancellation,
    shortLink(url),
  ];
  return parts.filter(Boolean).join(" · ");
}

export function shortLink(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

/** What the group usually needs to compare that the page didn't say. */
export function missingFields(l: Listing): string[] {
  const missing: string[] = [];
  if (!l.price) missing.push("price");
  if (l.sleeps === undefined) missing.push("sleeps");
  if (l.bedrooms === undefined) missing.push("bedrooms");
  if (!l.cancellation) missing.push("cancellation policy");
  return missing;
}
