// The look shared by Nod's public pages (the home page, "check your texts", /join): centred,
// rounded sans to match the wordmark, white or black. Nod's name in a heading is drawn as the
// logo (inlineLogo), as on the home page.

import { esc } from "../web/theme";
import { nodWordmarkSvg } from "./logo";

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
.fine a,.nocode a{color:var(--ink);font-weight:600;text-decoration:none}
.nocode{font-size:16px;color:var(--grey)}
.fine{font-size:13px;line-height:1.5;color:var(--grey);max-width:28em}
.logo-inline{display:inline-block;height:1.3em;width:auto;vertical-align:-.29em;margin-left:.06em}
.code{width:100%;font:600 30px/1.2 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.08em;padding:20px;border-radius:24px;background:var(--panel)}
.field.code-input{font-family:ui-monospace,"SF Mono",Menlo,monospace;text-transform:uppercase;letter-spacing:.06em}
`;

/** `sms:` with a prefilled body; the `?&body=` form works on both iOS and Android. */
export function smsLink(phone: string, body?: string): string {
  return body ? `sms:${phone}?&body=${encodeURIComponent(body)}` : `sms:${phone}`;
}

export function prettyPhone(phone: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone;
}

/** The wordmark sized to sit in a line of heading text ("You're invited to [nod]"). */
export function inlineLogo(): string {
  return nodWordmarkSvg({ height: 64, title: "Nod" }).replace("<svg ", '<svg class="logo-inline" ');
}

export function sitePage(main: string, o: { title?: string; description?: string; image?: string; index?: boolean }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<title>${esc(o.title ?? "Nod")}</title>${o.index === false ? `<meta name="robots" content="noindex">` : ""}${o.description ? `<meta name="description" content="${esc(o.description)}">
<meta property="og:title" content="${esc(o.title ?? "Nod")}"><meta property="og:description" content="${esc(o.description)}">` : ""}${o.image ? `<meta property="og:image" content="${esc(o.image)}">` : ""}<meta name="twitter:card" content="summary">
<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/nod-logo.png">
<style>${CSS}</style></head>
<body><main>${main}</main></body></html>`;
}
