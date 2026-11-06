// The look shared by Nod's public pages (the home page, "check your texts", /join): centred,
// rounded sans to match the wordmark, white or black. Nod's name in a heading is drawn as the
// logo (inlineLogo), as on the home page.

import { esc } from "../web/theme";
import { nodWordmarkSvg } from "./logo";

const CSS = `
:root{--bg:#fff;--ink:#1c1c1e;--soft:#636366;--grey:#8e8e93;--line:#e5e5ea;--panel:#f2f2f7;--bubble:#e5e5ea;--mine:#1c1c1e;--mine-ink:#fff;--btn:#1c1c1e;--btn-ink:#fff;--live:#34c759;--live-ring:rgba(52,199,89,.18)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#000;--ink:#f2f2f7;--soft:#aeaeb2;--grey:#8e8e93;--line:#2c2c2e;--panel:#1c1c1e;--bubble:#2c2c2e;--mine:#f2f2f7;--mine-ink:#1c1c1e;--btn:#f2f2f7;--btn-ink:#1c1c1e;--live:#30d158;--live-ring:rgba(48,209,88,.22)}}
:root[data-theme="dark"]{--bg:#000;--ink:#f2f2f7;--soft:#aeaeb2;--grey:#8e8e93;--line:#2c2c2e;--panel:#1c1c1e;--bubble:#2c2c2e;--mine:#f2f2f7;--mine-ink:#1c1c1e;--btn:#f2f2f7;--btn-ink:#1c1c1e;--live:#30d158;--live-ring:rgba(48,209,88,.22)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Helvetica Neue",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:520px;margin:0 auto;padding-block:56px 48px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:flex;flex-direction:column;align-items:center;text-align:center;gap:24px}
.mark{color:var(--ink);line-height:0}
h1{font-size:36px;line-height:1.08;font-weight:700;letter-spacing:-.035em;margin:4px 0 0;text-wrap:balance}
h2{font-size:22px;line-height:1.2;font-weight:650;letter-spacing:-.02em;margin:0;text-wrap:balance}
.hero{display:flex;flex-direction:column;align-items:center;gap:18px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font:500 12px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--soft);border:1px solid var(--line);border-radius:999px;padding:7px 12px}
.eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--live);box-shadow:0 0 0 3px var(--live-ring)}
.block{width:100%;display:flex;flex-direction:column;align-items:center;gap:14px;padding-top:28px;border-top:1px solid var(--line)}
.features{width:100%;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:18px;overflow:hidden;margin-top:6px}
.feat{background:var(--bg);padding:18px;text-align:left;display:flex;flex-direction:column;gap:8px;min-width:0}
.feat .tag{font:500 11px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--grey)}
.feat code{font:500 13.5px/1.35 ui-monospace,"SF Mono",Menlo,monospace;color:var(--ink);background:var(--panel);border-radius:8px;padding:6px 9px;align-self:flex-start;max-width:100%;overflow-wrap:anywhere}
.feat p:last-child{font-size:15px;line-height:1.45;color:var(--soft)}
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
.consent a{color:var(--grey)}
.btn{border:0;font-family:inherit;cursor:pointer;-webkit-appearance:none;display:flex;align-items:center;justify-content:center;width:100%;min-height:56px;border-radius:999px;background:var(--btn);color:var(--btn-ink);font-weight:600;font-size:18px;text-decoration:none}
.btn:active{opacity:.75}
.more{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;font-size:16px;color:var(--grey);margin-top:-10px}
.more a{color:var(--ink);text-decoration:none;font-weight:600}
.fine a,.nocode a{color:var(--ink);font-weight:600;text-decoration:none}
.nocode{font-size:16px;color:var(--grey)}
.fine{font-size:13px;line-height:1.5;color:var(--grey);max-width:28em}
.legal{width:100%;text-align:left;font-size:16px;line-height:1.55;display:flex;flex-direction:column;gap:12px}
.legal h2{font-size:19px;letter-spacing:-.01em;margin:14px 0 0}
.legal ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}
.legal a{color:var(--ink)}
.legal strong{font-weight:650}
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
