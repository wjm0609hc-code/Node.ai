// One look for every page Nod links to (pay, payouts, search results, settings, invites),
// matching the product cards people tap in the chat: iOS-style grey background, white
// rounded sheets, the card's photo-first layout, bold names, green amounts, black pill buttons.
// System fonts, so pages read as SF on iPhone like the chat they came from. Light and dark.

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Only http(s) links are ever put in an href. */
export const safeHref = (u: string | undefined | null) => (u && /^https?:\/\//i.test(u) ? esc(u) : undefined);

const CSS = `
:root{--bg:#f2f2f7;--sheet:#fff;--ink:#1c1c1e;--grey:#8e8e93;--faint:#c7c7cc;--line:#e5e5ea;--tile:#f3eee8;--tile-ink:#d9cfc3;--green:#2e9e5b;--btn:#1c1c1e;--btn-ink:#fff;--red:#ff3b30;--shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#000;--sheet:#1c1c1e;--ink:#f2f2f7;--grey:#98989f;--faint:#636366;--line:#38383a;--tile:#2c2c2e;--tile-ink:#48484a;--green:#34c759;--btn:#f2f2f7;--btn-ink:#1c1c1e;--shadow:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:440px;margin:0 auto;padding:20px 16px 40px;display:flex;flex-direction:column;gap:14px}
a{color:inherit}
h1{font-size:28px;line-height:1.15;letter-spacing:-.02em;margin:6px 4px 0}
h2{font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--grey);margin:10px 8px -4px}
p{margin:0}
.sub{color:var(--grey);font-size:15px;margin:2px 4px 0}
.note{color:var(--grey);font-size:13px;line-height:1.45;margin:0 8px}
.sheet{background:var(--sheet);border-radius:22px;padding:18px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:12px}
.card{background:var(--sheet);border-radius:26px;padding:10px;box-shadow:var(--shadow);display:block;text-decoration:none;color:inherit}
.card .ph{position:relative;aspect-ratio:4/3;border-radius:18px;overflow:hidden;background:var(--tile);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:96px;color:var(--tile-ink)}
.card .ph img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.card .num{position:absolute;top:10px;left:10px;min-width:28px;height:28px;border-radius:8px;background:rgba(28,28,30,.92);color:#fff;font-size:15px;font-weight:600;display:flex;align-items:center;justify-content:center;padding:0 6px}
.card .meta{padding:10px 6px 4px}
.card .src{font-size:13px;color:var(--grey)}
.card .row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:1px}
.card .name{font-size:19px;font-weight:700;letter-spacing:-.01em}
.card .price{color:var(--green);font-weight:600;font-size:17px;white-space:nowrap}
.card .details{font-size:14px;color:var(--grey);margin-top:2px}
.card .foot{display:flex;justify-content:space-between;font-size:12px;color:var(--faint);margin-top:10px}
.card .foot b{font-weight:600}
.card.short .ph{aspect-ratio:2/1;font-size:72px}
.amount{font-size:44px;font-weight:700;letter-spacing:-.03em;color:var(--ink)}
.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:52px;border:0;border-radius:16px;background:var(--btn);color:var(--btn-ink);font-family:inherit;font-weight:600;font-size:17px;line-height:1;text-decoration:none;cursor:pointer;-webkit-appearance:none}
.btn:disabled{opacity:.5}
.btn.quiet{background:transparent;color:var(--ink);border:1px solid var(--line);min-height:36px;width:auto;padding:0 14px;font-size:15px;border-radius:12px}
.btn.small{min-height:36px;width:auto;padding:0 14px;font-size:15px;border-radius:12px}
.list{display:flex;flex-direction:column}
.list .item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
.list .item:first-child{border-top:0;padding-top:2px}
.tag{font-size:12px;color:var(--grey)}
.status{display:flex;gap:12px;align-items:flex-start}
.status .dot{flex:none;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;background:var(--green)}
.status .dot.wait{background:var(--grey)}.status .dot.off{background:var(--faint)}
.code{font:600 30px/1.2 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.08em;text-align:center;padding:18px;border-radius:18px;background:var(--bg)}
.error{color:var(--red);font-size:14px;min-height:1.2em}
form{margin:0}
input[type=text],input:not([type]){width:100%;font:17px ui-monospace,"SF Mono",Menlo,monospace;padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:var(--bg);color:var(--ink);text-transform:uppercase}
.brand{align-self:center;color:var(--faint);font-weight:700;font-size:15px;letter-spacing:-.02em;margin-top:6px}
`;

export interface PageOptions {
  title: string;
  body: string;
  head?: string;
  /** Hide the small "nod" mark at the bottom. */
  bare?: boolean;
}

export function webPage(o: PageOptions): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${esc(o.title)}</title><style>${CSS}</style>${o.head ?? ""}</head>
<body><main>${o.body}${o.bare ? "" : `<div class="brand">nod</div>`}</main></body></html>`;
}

export interface CardView {
  number?: number;
  photoUrl?: string;
  /** Shown in place of a photo (a letter or "$"). */
  glyph?: string;
  source?: string;
  name: string;
  price?: string;
  details?: string;
  footer?: string;
  href?: string;
  /** No photo area at all (lists of many picks). */
  compact?: boolean;
  /** A shorter photo area (cards that only have a tile, like a pay request). */
  short?: boolean;
}

/** The product card, in HTML: the same layout as the picture in the chat. */
export function cardHtml(c: CardView): string {
  const tag = c.href ? "a" : "div";
  const href = c.href ? ` href="${esc(c.href)}" rel="noopener nofollow"` : "";
  const photo = c.compact
    ? ""
    : `<div class="ph">${esc((c.glyph ?? c.name.trim()[0] ?? "N").toUpperCase())}${c.photoUrl && safeHref(c.photoUrl) ? `<img src="${safeHref(c.photoUrl)}" alt="" loading="lazy" onerror="this.remove()">` : ""}${c.number !== undefined ? `<span class="num">${c.number}</span>` : ""}</div>`;
  const num = c.compact && c.number !== undefined ? `<span class="tag">${c.number}</span> ` : "";
  return `<${tag} class="card${c.compact ? " compact" : ""}${c.short ? " short" : ""}"${href}>${photo}<div class="meta">
${c.source ? `<div class="src">${num}${esc(c.source)}</div>` : ""}
<div class="row"><span class="name">${esc(c.name)}</span>${c.price ? `<span class="price">${esc(c.price)}</span>` : ""}</div>
${c.details ? `<div class="details">${esc(c.details)}</div>` : ""}
${c.footer ? `<div class="foot"><span>${esc(c.footer)}</span></div>` : ""}
</div></${tag}>`;
}

/** A status line with a round mark: ✓ done, … waiting, – closed. */
export function statusHtml(kind: "done" | "wait" | "off", title: string, text: string): string {
  const mark = kind === "done" ? "✓" : kind === "wait" ? "…" : "–";
  return `<div class="sheet"><div class="status"><span class="dot ${kind === "done" ? "" : kind}">${mark}</span><div><p style="font-weight:600">${esc(title)}</p><p class="sub" style="margin:2px 0 0">${esc(text)}</p></div></div></div>`;
}
