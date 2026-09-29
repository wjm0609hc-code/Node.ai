// The full results page for a search (/s/[searchId]), linked from Nod's reply
// so the chat message can stay short (rule 2). Shows no names or chat content.

import { formatPickCard, type Pick } from "./picks";

export interface SearchPageData {
  query: string;
  location: string | null;
  whenText: string | null;
  createdAt: Date;
  results: { picks?: Pick[] } | Record<string, unknown>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeHref = (u: string | undefined) => (u && /^https?:\/\//i.test(u) ? esc(u) : undefined);
const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export function renderSearchPage(s: SearchPageData): string {
  const picks = ((s.results as { picks?: Pick[] }).picks ?? []) as Pick[];
  const context = [s.location, s.whenText].filter(Boolean).join(" · ");
  const items = picks
    .map((p) => {
      const href = safeHref(p.url);
      const booking = safeHref(p.bookingUrl);
      const details = [p.summary, p.when, p.priceHint, p.address].filter(Boolean).map((d) => esc(d!)).join(" · ");
      return `<li><h2>${href ? `<a href="${href}" rel="noopener nofollow">${esc(p.name)}</a>` : esc(p.name)}</h2>
<p>${details}</p>${booking ? `<p><a href="${booking}" rel="noopener nofollow">Book or get tickets</a></p>` : ""}</li>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nod search: ${esc(s.query)}</title>
<style>
:root{--bg:#f6f6f3;--fg:#17181b;--muted:#63666d;--line:#dedfda;--accent:#a8520a}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--fg:#ecedef;--muted:#9a9ea6;--line:#2b2d31;--accent:#f0a04a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px;font-size:14px}
ol{padding:0;margin:0;list-style:none;display:flex;flex-direction:column;gap:12px}
li{border:1px solid var(--line);border-radius:10px;padding:12px 14px}
h2{font-size:17px;margin:0 0 4px}a{color:var(--accent)}li p{margin:0;color:var(--muted);font-size:14px}
</style></head><body><main>
<h1>${esc(s.query)}</h1>
<p class="sub">${context ? `${esc(context)} · ` : ""}Searched ${DAY.format(s.createdAt)} by Nod. Check details with the venue before you go.</p>
${picks.length ? `<ol>\n${items}\n</ol>` : "<p>Nothing confirmed turned up for this search.</p>"}
</main></body></html>`;
}

export { formatPickCard };
