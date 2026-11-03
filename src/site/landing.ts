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
:root{--bg:#fff;--ink:#1c1c1e;--soft:#636366;--grey:#8e8e93;--line:#e5e5ea;--panel:#f2f2f7;--bubble:#e5e5ea;--mine:#1c1c1e;--mine-ink:#fff;--btn:#1c1c1e;--btn-ink:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#000;--ink:#f2f2f7;--soft:#aeaeb2;--grey:#8e8e93;--line:#2c2c2e;--panel:#1c1c1e;--bubble:#2c2c2e;--mine:#f2f2f7;--mine-ink:#1c1c1e;--btn:#f2f2f7;--btn-ink:#1c1c1e}}
:root[data-theme="dark"]{--bg:#000;--ink:#f2f2f7;--soft:#aeaeb2;--grey:#8e8e93;--line:#2c2c2e;--panel:#1c1c1e;--bubble:#2c2c2e;--mine:#f2f2f7;--mine-ink:#1c1c1e;--btn:#f2f2f7;--btn-ink:#1c1c1e}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.45 ui-rounded,"SF Pro Rounded",-apple-system,BlinkMacSystemFont,"Helvetica Neue",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:460px;margin:0 auto;padding:56px 16px 48px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:24px}
.mark{color:var(--ink);line-height:0}
h1{font-size:34px;line-height:1.1;font-weight:700;letter-spacing:-.025em;margin:4px 0 0}
p{margin:0}
.sub{color:var(--soft);font-size:18px;max-width:22em}
.chat{width:100%;background:var(--panel);border-radius:28px;padding:18px 14px;display:flex;flex-direction:column;gap:5px;text-align:left;font:16px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif}
.chat .who{font-size:11px;color:var(--grey);margin:6px 12px 0}
.chat .who:first-child{margin-top:0}
.chat .b{position:relative;max-width:82%;padding:8px 13px;border-radius:18px;background:var(--bubble);align-self:flex-start}
.chat .b.me{align-self:flex-end;background:var(--mine);color:var(--mine-ink)}
.chat .tap{position:absolute;top:-12px;right:-8px;font-size:13px;background:var(--bg);border-radius:12px;padding:2px 5px;box-shadow:0 0 0 2px var(--panel)}
.chat .b.voted{margin-top:10px}
ol{list-style:none;counter-reset:step;padding:0;margin:0;width:100%;display:flex;flex-direction:column;gap:12px;text-align:left}
ol li{display:flex;gap:14px;align-items:center;counter-increment:step}
ol li::before{content:counter(step);flex:none;width:30px;height:30px;border-radius:50%;background:var(--ink);color:var(--bg);font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center}
.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:56px;border-radius:999px;background:var(--btn);color:var(--btn-ink);font-weight:600;font-size:18px;text-decoration:none}
.btn:active{opacity:.75}
.more{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;font-size:16px;color:var(--grey);margin-top:-10px}
.more a{color:var(--ink);text-decoration:none;font-weight:600}
.fine{font-size:13px;line-height:1.5;color:var(--grey);max-width:28em}
`;

export function renderLanding(d: LandingData): string {
  const phone = d.nodPhone;
  const tryHref = phone ? smsLink(phone, "Hey Nod") : "/join";
  const inviteHref = phone ? smsLink(phone, "Give me an invite for a friend") : "/join";
  const base = d.appUrl?.replace(/\/+$/, "") ?? "";
  const description = "Nod is an assistant for your group chat. It stays quiet until you call it, then helps the group decide, book and split the cost.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<title>Nod</title><meta name="description" content="${esc(description)}">
<meta property="og:title" content="Nod"><meta property="og:description" content="${esc(description)}">${base ? `<meta property="og:image" content="${esc(base)}/nod-logo.png">` : ""}<meta name="twitter:card" content="summary">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/nod-logo.png">
<style>${CSS}</style></head>
<body><main>
<div class="mark">${nodWordmarkSvg({ height: 48, title: "Nod" })}</div>
<h1>The quiet one in your group chat.</h1>
<p class="sub">Nod stays out of the way until someone tags it. Then it finds the place, runs the vote, books it and splits the bill.</p>
<div class="chat" aria-label="Example group chat">
<div class="who">Sarah</div><div class="b">@Nod dinner for 6 on Saturday? Mike's vegetarian</div>
<div class="who">Nod</div><div class="b">Four spots with real veggie plates, all open Saturday night. Tap 👍 on your pick.</div>
<div class="b voted">Lupa Trattoria<span class="tap">👍 3</span></div>
<div class="b me">Booking it 🙌</div>
</div>
<ol>
<li>Add Nod to any iMessage group</li>
<li>Tag @Nod when you need something</li>
<li>Everyone taps to vote and pay</li>
</ol>
<a class="btn" href="${esc(tryHref)}">Text Nod to get started</a>
<p class="more"><a href="/join">Have an invite code?</a><span aria-hidden="true">·</span><a href="${esc(inviteHref)}">Invite a friend</a></p>
<p class="fine">Signing up is a text, so there's no password. Nod only sees a group's messages after it's added, never spends without the group's OK, and never holds your money.</p>
</main></body></html>`;
}
