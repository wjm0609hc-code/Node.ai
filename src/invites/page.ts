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

import { esc } from "../web/theme";
import { inlineLogo, prettyPhone, sitePage, smsLink } from "../site/shell";

export { smsLink };

export function renderJoinPage(d: JoinPageData): string {
  const phone = d.nodPhone;
  const number = phone ? `<p class="fine">Nod's number: <strong>${esc(prettyPhone(phone))}</strong></p>` : "";
  const body = d.code
    ? `<h1>You're invited to ${inlineLogo()}</h1>
<p class="sub">The AI agent for group chats. Tag it and it finds the place, runs the vote, books it and splits the bill.</p>
<div class="code">${esc(d.code)}</div>
${phone ? `<a class="btn" href="${esc(smsLink(phone, d.code))}">Text the code to Nod</a>` : `<p class="sub">Text this code to Nod to get started.</p>`}
${number}
<p class="fine">Each code works once. Texting it from your phone is how Nod knows it's you.</p>
<p class="more"><a href="/">What's Nod?</a><span aria-hidden="true">·</span><a href="/privacy">Privacy</a><span aria-hidden="true">·</span><a href="/terms">Terms</a></p>`
    : `<h1>Join ${inlineLogo()}</h1>
<p class="sub">Have an invite code? Enter it, then text it to Nod.</p>
${d.invalid ? `<p class="err" role="alert">That doesn't look like an invite code. Check the link or type the code below.</p>` : ""}
<form class="join" method="get" action="/join"><input class="field code-input" name="code" placeholder="NOD-XXXXXX" autocapitalize="characters" autocomplete="off" maxlength="12" required aria-label="Invite code"><button class="btn" type="submit">Continue</button></form>
<p class="nocode">No code? ${phone ? `<a href="${esc(smsLink(phone))}">Text Nod</a> or ` : ""}<a href="/">sign up</a> to join the waitlist.</p>
${number}`;
  return sitePage(body, { title: "Join Nod", index: false });
}
