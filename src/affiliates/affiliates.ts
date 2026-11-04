// Affiliate links: every link out of Nod to a partner's site carries Nod's tag when that program
// is set up, so bookings people make through Nod earn a commission. Nothing changes for people
// (same page, same price), and links pass through untouched until a program's setting exists.
//
// Each program has one setting (an environment variable). Its value is either:
// - the tag itself (e.g. Booking.com's "123456"), added as the program's link parameter, or
// - a tracking link from an affiliate network with {url} where the destination goes
//   (e.g. "https://partner.example/c/1/2/3?u={url}"), for programs that track that way.
//
// Picks are never ranked by commission; this only tags links people already chose to open.
// TODO(verify against each program's docs once approved): the parameter names below come from
// the programs' public links, not official documentation.

// Three layers, tried in order for each link:
// 1. Extra programs from NOD_AFFILIATE_EXTRA (JSON), so a new program is a setting, not a code change.
// 2. The built-in programs below, each with its own NOD_AFFILIATE_* setting.
// 3. A catch-all network (NOD_AFFILIATE_FALLBACK, e.g. Skimlinks or Sovrn) for every other shop or
//    travel site, so almost any link Nod sends can earn.
// Every link can carry an anonymous label ("sub-ID": a card or search id, never anything about a
// person) so the programs' reports show which cards earn.

export interface AffiliateProgram {
  name: string;
  /** The setting that holds the tag or tracking link (built-in programs). */
  env?: string;
  hosts: RegExp;
  /** The link parameter that carries the tag, for programs that track by parameter. */
  param?: string;
  /** The link parameter that carries the anonymous label, when the program has one. */
  subParam?: string;
  /** The tag or tracking link itself (extra programs carry it inline). */
  setting?: string;
}

export interface LinkOptions {
  /** Anonymous label for reports: letters, digits, "-" and "_" only. */
  sub?: string;
}

export const PROGRAMS: AffiliateProgram[] = [
  { name: "Booking.com", env: "NOD_AFFILIATE_BOOKING", hosts: /(^|\.)booking\.com$/, param: "aid", subParam: "label" },
  { name: "Expedia Group (Expedia, Vrbo, Hotels.com)", env: "NOD_AFFILIATE_EXPEDIA", hosts: /(^|\.)(expedia\.[a-z.]+|vrbo\.com|hotels\.com)$/ },
  { name: "Viator", env: "NOD_AFFILIATE_VIATOR", hosts: /(^|\.)viator\.com$/, param: "pid" },
  { name: "GetYourGuide", env: "NOD_AFFILIATE_GETYOURGUIDE", hosts: /(^|\.)getyourguide\.[a-z.]+$/, param: "partner_id", subParam: "cmp" },
  { name: "OpenTable", env: "NOD_AFFILIATE_OPENTABLE", hosts: /(^|\.)opentable\.[a-z.]+$/, param: "ref" },
  { name: "SeatGeek", env: "NOD_AFFILIATE_SEATGEEK", hosts: /(^|\.)seatgeek\.com$/, param: "aid" },
  { name: "StubHub", env: "NOD_AFFILIATE_STUBHUB", hosts: /(^|\.)stubhub\.[a-z.]+$/ },
  { name: "Ticketmaster", env: "NOD_AFFILIATE_TICKETMASTER", hosts: /(^|\.)(ticketmaster\.[a-z.]+|livenation\.com)$/ },
  { name: "Amazon", env: "NOD_AFFILIATE_AMAZON", hosts: /(^|\.)amazon\.com$/, param: "tag", subParam: "ascsubtag" },
  { name: "Instacart", env: "NOD_AFFILIATE_INSTACART", hosts: /(^|\.)instacart\.com$/ },
  { name: "DoorDash", env: "NOD_AFFILIATE_DOORDASH", hosts: /(^|\.)doordash\.com$/ },
  { name: "Uber Eats", env: "NOD_AFFILIATE_UBEREATS", hosts: /(^|\.)ubereats\.com$/ },
];

/** One line for pages that carry these links (FTC disclosure). */
export const AFFILIATE_DISCLOSURE = "Nod may earn a commission when you book through its links. It never changes what you pay or which places Nod suggests.";

/** Sites the catch-all network never wraps: Nod itself, maps and search, and money apps. */
const NEVER_WRAP = /(^|\.)(google\.[a-z.]+|goo\.gl|apple\.com|venmo\.com|paypal\.com|stripe\.com|cash\.app|sendblue\.co|nod\.ai)$/;

/**
 * The link with Nod's tag for its program (or the catch-all network's), or the link unchanged.
 * Never replaces a tag already on a link. Always returns an http(s) link or the input.
 */
export function affiliateLink(raw: string, env: NodeJS.ProcessEnv = process.env, opts: LinkOptions = {}): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return raw;
  const host = url.hostname.toLowerCase();
  const sub = opts.sub && /^[A-Za-z0-9_-]{1,64}$/.test(opts.sub) ? opts.sub : "";

  for (const program of [...extraPrograms(env), ...PROGRAMS]) {
    if (!program.hosts.test(host)) continue;
    const setting = (program.setting ?? (program.env ? env[program.env] : undefined))?.trim();
    if (!setting) break; // a known program that isn't set up: try the catch-all network
    if (setting.includes("{url}")) return wrap(setting, raw, sub);
    if (!program.param || url.searchParams.has(program.param)) return raw;
    url.searchParams.set(program.param, setting);
    if (sub && program.subParam && !url.searchParams.has(program.subParam)) url.searchParams.set(program.subParam, sub);
    return url.toString();
  }

  const fallback = env.NOD_AFFILIATE_FALLBACK?.trim();
  if (!fallback?.includes("{url}") || NEVER_WRAP.test(host) || ownHost(env) === host) return raw;
  return wrap(fallback, raw, sub);
}

function wrap(template: string, raw: string, sub: string): string {
  const wrapped = template.replace("{url}", encodeURIComponent(raw)).replace("{sub}", encodeURIComponent(sub));
  return isWebLink(wrapped) ? wrapped : raw;
}

function ownHost(env: NodeJS.ProcessEnv): string | null {
  try {
    return env.NOD_APP_URL ? new URL(env.NOD_APP_URL).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

interface ExtraProgramSetting {
  name: string;
  /** Domains the program covers, e.g. ["agoda.com"] (subdomains included). */
  domains: string[];
  /** A tag added as `param`... */
  tag?: string;
  param?: string;
  /** ...or a tracking link with {url} (and optionally {sub}). */
  link?: string;
  subParam?: string;
}

const extraCache = new Map<string, AffiliateProgram[]>();

/** Programs added as a setting: NOD_AFFILIATE_EXTRA, a JSON list. Bad entries are skipped. */
export function extraPrograms(env: NodeJS.ProcessEnv = process.env): AffiliateProgram[] {
  const raw = env.NOD_AFFILIATE_EXTRA?.trim();
  if (!raw) return [];
  const cached = extraCache.get(raw);
  if (cached) return cached;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    list = [];
  }
  const programs: AffiliateProgram[] = [];
  for (const e of Array.isArray(list) ? (list as ExtraProgramSetting[]) : []) {
    const domains = Array.isArray(e?.domains) ? e.domains.filter((d) => typeof d === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d)) : [];
    if (!e?.name || !domains.length) continue;
    const hosts = new RegExp(`(^|\\.)(${domains.map((d) => d.toLowerCase().replace(/\./g, "\\.")).join("|")})$`);
    if (typeof e.link === "string" && e.link.includes("{url}")) programs.push({ name: e.name, hosts, setting: e.link });
    else if (typeof e.tag === "string" && typeof e.param === "string" && /^[A-Za-z0-9_-]+$/.test(e.param)) {
      programs.push({ name: e.name, hosts, setting: e.tag, param: e.param, ...(e.subParam ? { subParam: e.subParam } : {}) });
    }
  }
  extraCache.set(raw, programs);
  return programs;
}

/** Names of the programs that are set up (for the health check). */
export function activePrograms(env: NodeJS.ProcessEnv = process.env): string[] {
  const builtIn = PROGRAMS.filter((p) => p.env && env[p.env]?.trim()).map((p) => p.name);
  const extra = extraPrograms(env).map((p) => p.name);
  const fallback = env.NOD_AFFILIATE_FALLBACK?.includes("{url}") ? ["catch-all network"] : [];
  const promos = promoSettings(env).length ? [`${promoSettings(env).length} promo code${promoSettings(env).length === 1 ? "" : "s"}`] : [];
  return [...extra, ...builtIn, ...fallback, ...promos];
}

function isWebLink(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// ---- promo codes ----
// Some programs give partners a code ("NOD10") that credits Nod whenever it's used, on any device,
// any time later, by anyone in the group, so it survives the cases cookies don't (bought two weeks
// later, on a laptop, in the app). NOD_AFFILIATE_PROMOS is a JSON list:
//   [{"domains":["seatgeek.com"],"code":"NOD10","offer":"$10 off your first order","until":"2027-06-30"}]
// Only codes a program actually issued go here; Nod never invents one.

export interface Promo {
  code: string;
  /** What the code gets people, in a few words ("$10 off your first order"). */
  offer: string;
}

interface PromoSetting extends Promo {
  hosts: RegExp;
  /** Last day the code works, YYYY-MM-DD (inclusive). */
  until?: string;
}

const promoCache = new Map<string, PromoSetting[]>();

function promoSettings(env: NodeJS.ProcessEnv): PromoSetting[] {
  const raw = env.NOD_AFFILIATE_PROMOS?.trim();
  if (!raw) return [];
  const cached = promoCache.get(raw);
  if (cached) return cached;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    list = [];
  }
  const out: PromoSetting[] = [];
  for (const e of Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []) {
    const domains = Array.isArray(e?.domains) ? (e.domains as unknown[]).filter((d): d is string => typeof d === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d)) : [];
    const code = typeof e?.code === "string" ? e.code.trim() : "";
    const offer = typeof e?.offer === "string" ? e.offer.trim().replace(/\s+/g, " ") : "";
    const until = typeof e?.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.until) ? e.until : undefined;
    if (!domains.length || !/^[A-Za-z0-9-]{3,20}$/.test(code) || !offer || offer.length > 60) continue;
    const hosts = new RegExp(`(^|\\.)(${domains.map((d) => d.toLowerCase().replace(/\./g, "\\.")).join("|")})$`);
    out.push({ hosts, code, offer, ...(until ? { until } : {}) });
  }
  promoCache.set(raw, out);
  return out;
}

/** The promo code for this link's site, if a program issued one and it hasn't expired. */
export function promoFor(raw: string, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promo | null {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  const today = now.toISOString().slice(0, 10);
  const p = promoSettings(env).find((x) => x.hosts.test(host) && (!x.until || x.until >= today));
  return p ? { code: p.code, offer: p.offer } : null;
}

/** "Code NOD10: $10 off your first order." */
export function promoLine(p: Promo): string {
  return `Code ${p.code}: ${p.offer.replace(/[.!]+$/, "")}.`;
}
