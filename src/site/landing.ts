// The public home page at "/": what Nod is, and three ways in, all by text.
// Signing up is texting Nod (the waitlist, src/invites), because a text proves the
// phone is the person's; this page collects nothing and reads nothing.

import { smsLink } from "../invites/page";
import { esc } from "../web/theme";
import { nodWordmarkSvg } from "./logo";

export interface LandingData {
  /** Nod's number, E.164. Empty before it's configured. */
  nodPhone: string;
  /** Public app URL, for the preview image in link previews. */
  appUrl?: string;
}

const CSS = `
:root{--bg:#fbfaf7;--ink:#1c1c1e;--soft:#55555a;--grey:#8e8e93;--line:#e6e1da;--mark:#d8cfc3;--bubble:#ecebe8;--mine:#1c1c1e;--mine-ink:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e0e0f;--ink:#f2f2f4;--soft:#b5b5ba;--grey:#8e8e93;--line:#2e2c2a;--mark:#4a4540;--bubble:#232325;--mine:#f2f2f4;--mine-ink:#1c1c1e}}
:root[data-theme="dark"]{--bg:#0e0e0f;--ink:#f2f2f4;--soft:#b5b5ba;--grey:#8e8e93;--line:#2e2c2a;--mark:#4a4540;--bubble:#232325;--mine:#f2f2f4;--mine-ink:#1c1c1e}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:20px/1.45 ui-serif,"New York","Iowan Old Style",Georgia,serif;-webkit-font-smoothing:antialiased}
main{max-width:560px;margin:0 auto;padding:72px 24px 56px;display:flex;flex-direction:column;gap:28px}
.mark{color:var(--ink);display:block;line-height:0;margin-bottom:28px}
h1{font-size:30px;line-height:1.25;font-weight:500;letter-spacing:-.01em;margin:0}
p{margin:0}
.lede{color:var(--ink)}
.chat{display:flex;flex-direction:column;gap:6px;font:16px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif;margin:4px 0}
.chat .who{font-size:12px;color:var(--grey);margin:0 12px -2px}
.chat .b{max-width:84%;padding:9px 14px;border-radius:19px;background:var(--bubble)}
.chat .b.me{align-self:flex-end;background:var(--mine);color:var(--mine-ink)}
nav{display:flex;flex-direction:column;gap:14px;margin-top:8px}
nav a{font-size:26px;color:var(--ink);text-decoration:none;align-self:flex-start;background:linear-gradient(transparent 62%,var(--mark) 62%,var(--mark) 88%,transparent 88%);padding:0 2px}
nav a::after{content:" \\203A";font-family:-apple-system,system-ui,sans-serif;font-weight:300}
nav a:active{opacity:.6}
.fine{font-size:14px;line-height:1.5;color:var(--grey);border-top:1px solid var(--line);padding-top:20px;margin-top:20px}
`;

export function renderLanding(d: LandingData): string {
  const phone = d.nodPhone;
  const tryHref = phone ? smsLink(phone, "Hey Nod") : "/join";
  const inviteHref = phone ? smsLink(phone, "Give me an invite for a friend") : "/join";
  const base = d.appUrl?.replace(/\/+$/, "") ?? "";
  const description = "Nod is an assistant for your group chat. It stays quiet until you call it, then helps the group decide, book and split the cost.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#fbfaf7" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0e0e0f" media="(prefers-color-scheme: dark)">
<title>Nod</title><meta name="description" content="${esc(description)}">
<meta property="og:title" content="Nod"><meta property="og:description" content="${esc(description)}">${base ? `<meta property="og:image" content="${esc(base)}/nod-logo.png">` : ""}<meta name="twitter:card" content="summary">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/nod-logo.png">
<style>${CSS}</style></head>
<body><main>
<div><span class="mark">${nodWordmarkSvg({ height: 40, title: "Nod" })}</span>
<h1>Nod is an assistant for your group chat. It stays quiet until someone calls it.</h1></div>
<p class="lede">Then it finds the restaurant, puts the rentals to a vote, books the table and keeps track of who owes what.</p>
<p class="lede">There's nothing to download. Add Nod to any iMessage group and say @Nod.</p>
<div class="chat" aria-label="Example">
<div class="who">Sarah</div><div class="b">@Nod dinner for 6 on Saturday? Mike's vegetarian</div>
<div class="who">Nod</div><div class="b">Four spots with real veggie plates, all open Saturday night. Want me to put them to a vote?</div>
<div class="b me">yes</div>
</div>
<nav>
<a href="${esc(tryHref)}">Try Nod</a>
<a href="/join">I have an invite code</a>
<a href="${esc(inviteHref)}">Invite a friend</a>
</nav>
<p class="fine">Signing up is a text, so there's no password. Nod only reads a group's messages after it's added, never spends without the group's OK, and never holds your money.</p>
</main></body></html>`;
}
