// The public home page at "/": what Nod is, and the sign-up form. People type their
// first name and number and Nod texts them (POST /signup, src/site/signup.ts); from
// then on everything happens by text, and their number is their account. People can
// also just text Nod, enter an invite code (/join), or ask Nod for an invite for a friend.

import { smsLink } from "../invites/page";
import { esc } from "../web/theme";
import { nodWordmarkSvg } from "./logo";

export interface LandingData {
  /** Nod's number, E.164. Empty before it's configured. */
  nodPhone: string;
  /** Public app URL, for the preview image in link previews. */
  appUrl?: string;
  /** Shown above the form after a failed sign-up. */
  error?: string;
  /** What they typed, kept after a failed sign-up. */
  values?: { name?: string; phone?: string };
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
.field{width:100%;font:inherit;font-size:18px;text-align:center;padding:15px 18px;border-radius:999px;border:1px solid var(--line);background:var(--bg);color:var(--ink);-webkit-appearance:none;outline:none}
.field:focus{border-color:var(--grey)}
.field::placeholder{color:var(--grey)}
.join{width:100%;display:flex;flex-direction:column;gap:10px;margin:0}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.err{color:#ff3b30;font-size:15px}
.consent{font-size:12px;line-height:1.45;color:var(--grey);margin-top:2px}
.btn{border:0;font-family:inherit;cursor:pointer;-webkit-appearance:none;display:flex;align-items:center;justify-content:center;width:100%;min-height:56px;border-radius:999px;background:var(--btn);color:var(--btn-ink);font-weight:600;font-size:18px;text-decoration:none}
.btn:active{opacity:.75}
.more{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;font-size:16px;color:var(--grey);margin-top:-10px}
.more a{color:var(--ink);text-decoration:none;font-weight:600}
.fine{font-size:13px;line-height:1.5;color:var(--grey);max-width:28em}
`;

export function renderLanding(d: LandingData): string {
  const phone = d.nodPhone;
  const textHref = phone ? smsLink(phone, "Hey Nod") : null;
  const inviteHref = phone ? smsLink(phone, "Give me an invite for a friend") : "/join";
  const base = d.appUrl?.replace(/\/+$/, "") ?? "";
  const description = "Nod is an assistant for your group chat. It stays quiet until you call it, then helps the group decide, book and split the cost.";
  return shell(`<div class="mark">${nodWordmarkSvg({ height: 48, title: "Nod" })}</div>
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
<form class="join" id="signup" method="post" action="/signup">
${d.error ? `<p class="err" role="alert">${esc(d.error)}</p>` : ""}
<input class="field" name="name" type="text" placeholder="First name" autocomplete="given-name" autocapitalize="words" maxlength="30" aria-label="First name" value="${esc(d.values?.name ?? "")}">
<input class="field" name="phone" type="tel" inputmode="tel" placeholder="Mobile number" autocomplete="tel" maxlength="20" required aria-label="Mobile number" value="${esc(d.values?.phone ?? "")}">
<div class="hp" aria-hidden="true"><input name="website" type="text" tabindex="-1" autocomplete="off"></div>
<button class="btn" type="submit">Get Nod</button>
<p class="consent">Nod will text you to get you set up, or to save your spot if there's a wait. Msg &amp; data rates may apply. Reply STOP anytime.</p>
</form>
${textHref ? `<p class="more"><a href="${esc(textHref)}">Or just text Nod</a></p>` : ""}
<p class="more"><a href="/join">Have an invite code?</a><span aria-hidden="true">·</span><a href="${esc(inviteHref)}">Invite a friend</a></p>
<p class="fine">Your number is your account, so there's no password or app. Nod only sees a group's messages after it's added, never spends without the group's OK, and never holds your money.</p>
`, { description, image: base ? `${base}/nod-logo.png` : undefined });
}

/** After the form: check your texts (or try again later). */
export function renderSignupDone(d: { nodPhone: string; status: "sent" | "busy"; phone?: string }): string {
  const pretty = d.phone ? prettyPhone(d.phone) : "your phone";
  const body =
    d.status === "sent"
      ? `<h1>Check your texts.</h1><p class="sub">A text from Nod is on its way to ${esc(pretty)}. Your number is your account, so that's all it takes.</p>`
      : `<h1>Lots of sign-ups right now.</h1><p class="sub">Try again in a little while${d.nodPhone ? `, or <a href="${esc(smsLink(d.nodPhone, "Hey Nod"))}">text Nod</a> yourself` : ""}.</p>`;
  return shell(`<div class="mark">${nodWordmarkSvg({ height: 48, title: "Nod" })}</div>${body}<p class="more"><a href="/">Back</a></p>`, { index: false });
}

function prettyPhone(phone: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone;
}

function shell(main: string, o: { description?: string; image?: string; index?: boolean }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<title>Nod</title>${o.index === false ? `<meta name="robots" content="noindex">` : ""}${o.description ? `<meta name="description" content="${esc(o.description)}">
<meta property="og:title" content="Nod"><meta property="og:description" content="${esc(o.description)}">` : ""}${o.image ? `<meta property="og:image" content="${esc(o.image)}">` : ""}<meta name="twitter:card" content="summary">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/nod-logo.png">
<style>${CSS}</style></head>
<body><main>${main}</main></body></html>`;
}
