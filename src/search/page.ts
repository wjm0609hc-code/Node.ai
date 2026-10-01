// The full results page for a search (/s/[searchId]), linked from Nod's reply
// so the chat message can stay short (rule 2). Shows no names or chat content.

import { sourceName } from "../cards/spec";
import { cardHtml, esc, safeHref, webPage } from "../web/theme";
import { formatPickCard, type Pick } from "./picks";

export interface SearchPageData {
  query: string;
  location: string | null;
  whenText: string | null;
  createdAt: Date;
  results: { picks?: Pick[] } | Record<string, unknown>;
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export function renderSearchPage(s: SearchPageData): string {
  const picks = ((s.results as { picks?: Pick[] }).picks ?? []) as Pick[];
  const context = [s.location, s.whenText].filter(Boolean).join(" · ");
  const items = picks
    .map((p, i) => {
      const href = safeHref(p.url) ? p.url : undefined;
      const booking = safeHref(p.bookingUrl);
      const card = cardHtml({
        number: i + 1,
        compact: true,
        source: href ? sourceName(p.url) : undefined,
        name: p.name,
        price: p.priceHint,
        details: [p.summary, p.when, p.address].filter(Boolean).join(" · "),
        href,
      });
      return booking ? `<div style="display:flex;flex-direction:column;gap:6px">${card}<a class="btn small" style="align-self:flex-start;margin-left:10px" href="${booking}" rel="noopener nofollow">Book or get tickets</a></div>` : card;
    })
    .join("\n");
  return webPage({
    title: `Nod search: ${s.query}`,
    body: `<h1>${esc(s.query)}</h1>
<p class="sub">${context ? `${esc(context)} · ` : ""}Searched ${DAY.format(s.createdAt)}</p>
${picks.length ? items : `<div class="sheet"><p class="sub">Nothing confirmed turned up for this search.</p></div>`}
<p class="note">Found by Nod on the web. Check hours and prices with the venue before you go.</p>`,
  });
}

export { formatPickCard };
