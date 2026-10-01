// The /join page: someone opens a shared invite link and taps once to text the
// code to Nod. Redemption only ever happens by text, which proves the phone is
// theirs, so this page reads nothing from the database and redeems nothing.

export interface JoinPageData {
  /** A valid-looking code from the link, in canonical form. */
  code: string | null;
  /** The link had a code that isn't one. */
  invalid?: boolean;
  /** Nod's number, E.164. Empty before it's configured. */
  nodPhone: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** `sms:` with a prefilled body; the `?&body=` form works on both iOS and Android. */
export function smsLink(phone: string, body?: string): string {
  return body ? `sms:${phone}?&body=${encodeURIComponent(body)}` : `sms:${phone}`;
}

function prettyPhone(phone: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : phone;
}

export function renderJoinPage(d: JoinPageData): string {
  const phone = d.nodPhone;
  const number = phone ? `<p class="sub">Nod's number: <strong>${esc(prettyPhone(phone))}</strong></p>` : "";
  const body = d.code
    ? `<h1>You're invited to Nod</h1>
<p>Nod is an assistant for group chats: it helps your group pick, book and pay for things, right in iMessage.</p>
<p class="code">${esc(d.code)}</p>
${phone ? `<p><a class="button" href="${esc(smsLink(phone, d.code))}">Text the code to Nod</a></p>` : "<p>Text this code to Nod to get started.</p>"}
${number}
<p class="sub">Each code works once. Texting it from your phone is how Nod knows it's you.</p>`
    : `<h1>Join Nod</h1>
${d.invalid ? `<p class="warn">That doesn't look like an invite code. Check the link or type the code below.</p>` : ""}
<p>Have an invite code? Enter it and text it to Nod.</p>
<form method="get" action="/join"><input name="code" placeholder="NOD-XXXXXX" autocapitalize="characters" autocomplete="off" maxlength="12" required><button type="submit">Continue</button></form>
<p class="sub">No code? ${phone ? `<a href="${esc(smsLink(phone))}">Text Nod</a>` : "Text Nod"} and you'll be added to the waitlist.</p>
${number}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join Nod</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f6f6f3;--fg:#17181b;--muted:#63666d;--line:#dedfda;--accent:#a8520a;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--fg:#ecedef;--muted:#9a9ea6;--line:#2b2d31;--accent:#f0a04a;--on-accent:#17181b}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:480px;margin:0 auto;padding:40px 16px 48px}
h1{font-size:24px;margin:0 0 12px}.sub{color:var(--muted);font-size:14px}.warn{color:var(--accent)}
.code{font:600 28px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.06em;border:1px dashed var(--line);border-radius:10px;padding:14px;text-align:center}
.button,button{display:inline-block;background:var(--accent);color:var(--on-accent);border:0;border-radius:10px;padding:12px 18px;font:600 16px system-ui,sans-serif;text-decoration:none}
form{display:flex;gap:8px}input{flex:1;min-width:0;font:16px ui-monospace,Menlo,monospace;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);text-transform:uppercase}
a{color:var(--accent)}
</style></head><body><main>
${body}
</main></body></html>`;
}
