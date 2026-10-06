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

export interface AffiliateProgram {
  name: string;
  env: string;
  hosts: RegExp;
  /** The link parameter that carries the tag, for programs that track by parameter. */
  param?: string;
}

export const PROGRAMS: AffiliateProgram[] = [
  { name: "Booking.com", env: "NOD_AFFILIATE_BOOKING", hosts: /(^|\.)booking\.com$/, param: "aid" },
  { name: "Expedia Group (Expedia, Vrbo, Hotels.com)", env: "NOD_AFFILIATE_EXPEDIA", hosts: /(^|\.)(expedia\.[a-z.]+|vrbo\.com|hotels\.com)$/ },
  { name: "Viator", env: "NOD_AFFILIATE_VIATOR", hosts: /(^|\.)viator\.com$/, param: "pid" },
  { name: "GetYourGuide", env: "NOD_AFFILIATE_GETYOURGUIDE", hosts: /(^|\.)getyourguide\.[a-z.]+$/, param: "partner_id" },
  { name: "OpenTable", env: "NOD_AFFILIATE_OPENTABLE", hosts: /(^|\.)opentable\.[a-z.]+$/, param: "ref" },
  { name: "SeatGeek", env: "NOD_AFFILIATE_SEATGEEK", hosts: /(^|\.)seatgeek\.com$/, param: "aid" },
  { name: "StubHub", env: "NOD_AFFILIATE_STUBHUB", hosts: /(^|\.)stubhub\.[a-z.]+$/ },
  { name: "Ticketmaster", env: "NOD_AFFILIATE_TICKETMASTER", hosts: /(^|\.)(ticketmaster\.[a-z.]+|livenation\.com)$/ },
  { name: "Amazon", env: "NOD_AFFILIATE_AMAZON", hosts: /(^|\.)amazon\.com$/, param: "tag" },
  { name: "Instacart", env: "NOD_AFFILIATE_INSTACART", hosts: /(^|\.)instacart\.com$/ },
  { name: "DoorDash", env: "NOD_AFFILIATE_DOORDASH", hosts: /(^|\.)doordash\.com$/ },
  { name: "Uber Eats", env: "NOD_AFFILIATE_UBEREATS", hosts: /(^|\.)ubereats\.com$/ },
];

/** One line for pages that carry these links (FTC disclosure). */
export const AFFILIATE_DISCLOSURE = "Nod may earn a commission when you book through its links. It never changes what you pay or which places Nod suggests.";

/** The link with Nod's tag for its program, or the link unchanged. Always an http(s) link or the input. */
export function affiliateLink(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return raw;
  const program = PROGRAMS.find((p) => p.hosts.test(url.hostname.toLowerCase()));
  const setting = program ? env[program.env]?.trim() : undefined;
  if (!program || !setting) return raw;

  if (setting.includes("{url}")) {
    const wrapped = setting.replace("{url}", encodeURIComponent(raw));
    return isWebLink(wrapped) ? wrapped : raw;
  }
  if (!program.param || url.searchParams.has(program.param)) return raw;
  url.searchParams.set(program.param, setting);
  return url.toString();
}

/** Names of the programs that are set up (for the health check). */
export function activePrograms(env: NodeJS.ProcessEnv = process.env): string[] {
  return PROGRAMS.filter((p) => env[p.env]?.trim()).map((p) => p.name);
}

function isWebLink(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
