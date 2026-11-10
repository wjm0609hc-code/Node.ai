// The private stats page (/admin/stats?token=…): what Nod sends and what people open.

import { esc } from "../web/theme";
import { nodWordmarkSvg } from "../site/logo";
import type { Row, Stats } from "./stats";

const CSS = `
@font-face{font-family:"Geist";src:url(/fonts/Geist-Variable.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(/fonts/GeistMono-Variable.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{--bg:#fff;--ink:#1c1c1e;--soft:#636366;--grey:#8e8e93;--line:#e5e5ea;--panel:#f6f6f8;--bar:#1c1c1e;--track:#ececf0;--ok:#248a3d;--warn:#b25000}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#000;--ink:#f2f2f7;--soft:#aeaeb2;--grey:#8e8e93;--line:#2c2c2e;--panel:#111113;--bar:#f2f2f7;--track:#2c2c2e;--ok:#30d158;--warn:#ff9f0a}}
:root[data-theme="dark"]{--bg:#000;--ink:#f2f2f7;--soft:#aeaeb2;--grey:#8e8e93;--line:#2c2c2e;--panel:#111113;--bar:#f2f2f7;--track:#2c2c2e;--ok:#30d158;--warn:#ff9f0a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 "Geist",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1040px;margin:0 auto;padding-block:40px 56px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:28px}
header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px}
h1{font-size:28px;letter-spacing:-.03em;line-height:1.1;margin:0;display:flex;align-items:baseline;gap:.35em}
h1 svg{height:1.15em;width:auto;vertical-align:-.19em}
.sub{color:var(--soft);margin:6px 0 0}
.mono{font-family:"Geist Mono",ui-monospace,Menlo,monospace}
.range{display:flex;gap:4px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:3px}
.range a{font:500 13px/1 "Geist Mono",ui-monospace,monospace;color:var(--soft);text-decoration:none;padding:7px 10px;border-radius:7px}
.range a[aria-current]{background:var(--bg);color:var(--ink);box-shadow:0 0 0 1px var(--line)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.tile{background:var(--bg);padding:16px 18px;display:grid;gap:4px}
.tile .k{font:500 11px/1 "Geist Mono",ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--grey)}
.tile .v{font-size:30px;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.1}
.tile .n{font-size:13px;color:var(--soft)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:16px}
section.card{border:1px solid var(--line);border-radius:14px;padding:18px;display:grid;gap:10px;align-content:start;min-width:0}
section.wide{grid-column:1/-1}
h2{font-size:16px;font-weight:600;letter-spacing:-.01em;margin:0}
.note{font-size:13px;color:var(--soft);margin:0}
.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{font:500 11px/1.2 "Geist Mono",ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--grey);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:0}
td.n,th.n{text-align:right;white-space:nowrap}
td.l{max-width:15rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar{height:6px;border-radius:3px;background:var(--track);min-width:60px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--bar);border-radius:3px}
.pill{font:500 11px/1 "Geist Mono",ui-monospace,monospace;padding:4px 7px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}
.pill.on{color:var(--ok);border-color:currentColor}
.pill.off{color:var(--warn);border-color:currentColor}
.funnel{display:grid;gap:10px}
.step{display:grid;grid-template-columns:minmax(110px,160px) 1fr auto;gap:12px;align-items:center}
.step .bar{height:10px;border-radius:5px}
.step .bar span{border-radius:5px}
.step b{font-variant-numeric:tabular-nums;font-weight:600}
.empty{color:var(--grey);font-size:14px;padding:6px 0}
footer{font-size:13px;color:var(--grey);display:grid;gap:4px}
`;

const n = (v: number) => v.toLocaleString("en-US");
const pct = (v: number) => `${Math.round(v * 100)}%`;
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export function renderStatsPage(s: Stats, o: { token: string }): string {
  const range = [7, 30, 90]
    .map((d) => `<a href="?token=${encodeURIComponent(o.token)}&amp;days=${d}"${d === s.days ? ' aria-current="page"' : ""}>${d}d</a>`)
    .join("");
  const top = Math.max(1, ...s.funnel.map((f) => f.value));
  const body = `<header>
<div><h1>${nodWordmarkSvg({ height: 64, title: "Nod" })} stats</h1><p class="sub">Last ${s.days} days, since ${esc(DATE.format(s.since))}. What Nod sent and what people opened.</p></div>
<nav class="range" aria-label="Time range">${range}</nav>
</header>
<div class="tiles">
${tile("Cards sent", n(s.cardsSent), `to ${n(s.groups)} group${s.groups === 1 ? "" : "s"}`)}
${tile("Cards opened", n(s.cardsTapped), `${pct(s.tapRate)} of cards sent`)}
${tile("Taps", n(s.taps), s.cardsTapped ? `${(s.taps / s.cardsTapped).toFixed(1)} per opened card` : "no taps yet")}
${tile("Votes decided", n(s.funnel[3]!.value), `${n(s.funnel[4]!.value)} booking${s.funnel[4]!.value === 1 ? "" : "s"} confirmed`)}
</div>
<section class="card wide"><h2>From search to booking</h2><p class="note">Searches people asked for, the picks Nod sent, the picks someone opened, then votes and confirmed bookings.</p>
<div class="funnel">${s.funnel.map((f) => `<div class="step"><span>${esc(f.label)}</span><div class="bar"><span style="width:${(100 * f.value) / top}%"></span></div><b>${n(f.value)}</b></div>`).join("")}</div></section>
<div class="grid">
${table("By link type", "What the link does. Compare Book on Resy, Website and Directions.", s.byLinkType)}
${table("By pick position", "Whether people open picks further down the list (Nod sends 6 restaurants and bars, 4 of anything else).", s.byPosition)}
${table("By site", "Where taps went, and whether an affiliate program covers that site. \"Not set up\" is a program worth applying to.", s.bySite, true)}
${table("By category", "What kind of thing the card was.", s.byCategory)}
${table("Most-opened places", "The places people opened most.", s.topPlaces, false, true)}
</div>
<footer>
<span>Counted per link, never per person: taps store no phone, IP or browser.</span>
<span>${n(s.earlyTaps)} hit${s.earlyTaps === 1 ? "" : "s"} within 15 seconds of a card being sent ${s.earlyTaps === 1 ? "was" : "were"} left out as likely link previews. Cards sent before tracking started show as "Not recorded".</span>
${s.truncated ? "<span>This range has more cards than the page reads; it shows the most recent.</span>" : ""}
</footer>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>Nod stats</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml"><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

function tile(k: string, v: string, note: string): string {
  return `<div class="tile"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><span class="n">${esc(note)}</span></div>`;
}

function table(title: string, note: string, rows: Row[], withProgram = false, wide = false): string {
  const most = Math.max(1, ...rows.map((r) => r.rate));
  const head = `<tr><th>${title === "By site" ? "Site" : title === "Most-opened places" ? "Place" : "Type"}</th><th class="n">Sent</th><th class="n">Opened</th><th class="n">Taps</th><th>Open rate</th>${withProgram ? "<th>Affiliate</th>" : ""}</tr>`;
  const bodyRows = rows
    .map(
      (r) => `<tr><td class="l" title="${esc(r.label)}">${esc(r.label)}</td><td class="n">${n(r.sent)}</td><td class="n">${n(r.tapped)}</td><td class="n">${n(r.taps)}</td><td><div style="display:flex;align-items:center;gap:8px"><div class="bar" style="flex:1"><span style="width:${(100 * r.rate) / most}%"></span></div><span class="mono" style="font-size:12px;min-width:3ch;text-align:right">${pct(r.rate)}</span></div></td>${
        withProgram ? `<td>${r.program ? `<span class="pill ${r.program.on ? "on" : "off"}">${r.program.on ? "On" : "Not set up"}</span>` : ""}</td>` : ""
      }</tr>`,
    )
    .join("");
  return `<section class="card${wide ? " wide" : ""}"><h2>${esc(title)}</h2><p class="note">${esc(note)}</p>${
    rows.length ? `<div class="wrap"><table><thead>${head}</thead><tbody>${bodyRows}</tbody></table></div>` : `<p class="empty">Nothing yet.</p>`
  }</section>`;
}
