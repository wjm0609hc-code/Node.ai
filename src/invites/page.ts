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

import { esc, webPage } from "../web/theme";

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
  const number = phone ? `<p class="note" style="text-align:center">Nod's number: <strong>${esc(prettyPhone(phone))}</strong></p>` : "";
  const body = d.code
    ? `<h1>You're invited to Nod</h1>
<p class="sub">An assistant for your group chats. It finds, books and splits the cost of things, right in iMessage.</p>
<div class="sheet">
<div class="code">${esc(d.code)}</div>
${phone ? `<a class="btn" href="${esc(smsLink(phone, d.code))}">Text the code to Nod</a>` : `<p class="sub" style="margin:0;text-align:center">Text this code to Nod to get started.</p>`}
</div>
${number}
<p class="note" style="text-align:center">Each code works once. Texting it from your phone is how Nod knows it's you.</p>`
    : `<h1>Join Nod</h1>
${d.invalid ? `<p class="error" style="margin:0 4px">That doesn't look like an invite code. Check the link or type the code below.</p>` : ""}
<div class="sheet">
<p>Have an invite code? Enter it, then text it to Nod.</p>
<form method="get" action="/join" style="display:flex;flex-direction:column;gap:10px"><input name="code" placeholder="NOD-XXXXXX" autocapitalize="characters" autocomplete="off" maxlength="12" required><button class="btn" type="submit">Continue</button></form>
</div>
<p class="note" style="text-align:center">No code? ${phone ? `<a href="${esc(smsLink(phone))}">Text Nod</a>` : "Text Nod"} and you'll join the waitlist.</p>
${number}`;
  return webPage({ title: "Join Nod", body });
}
