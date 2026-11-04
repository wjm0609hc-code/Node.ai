// The public home page at "/": what Nod is, and the sign-up form. People type their
// first name and number and Nod texts them (POST /signup, src/site/signup.ts); from
// then on everything happens by text, and their number is their account. People can
// also just text Nod, enter an invite code (/join), or ask Nod for an invite for a friend.

import { esc } from "../web/theme";
import { nodWordmarkSvg } from "./logo";
import { prettyPhone, sitePage as shell, smsLink } from "./shell";

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
