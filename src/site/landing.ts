// The public home page at "/": what Nod is, and the sign-up form. People type their
// first name and number and Nod texts them (POST /signup, src/site/signup.ts); from
// then on everything happens by text, and their number is their account. People can
// also just text Nod, enter an invite code (/join), or ask Nod for an invite for a friend.

import { AFFILIATE_DISCLOSURE } from "../affiliates/affiliates";
import { esc } from "../web/theme";
import { nodWordmarkSvg } from "./logo";
import { buttonLogo, inlineLogo, prettyPhone, sitePage as shell, smsLink } from "./shell";

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
  const description = "Nod is the AI agent for group chats. Tag it in any iMessage or SMS group and it finds the place, runs the vote, books it and splits the bill.";
  return shell(`<section class="hero">
<div class="mark">${nodWordmarkSvg({ height: 48, title: "Nod" })}</div>
<h1>The AI agent for group chats.</h1>
<p class="sub">Nod gets your group from “we should” to “we did.” Tag it and it finds the place, runs the vote, books it and splits the bill.</p>
</section>
<div class="chat" aria-label="Example group chat">
<div class="who">Sarah</div><div class="b">@Nod dinner for 6 Saturday? Somewhere we can actually talk</div>
<div class="who">Nod</div><div class="b">Six spots that take groups, all open Saturday night. Tap 👍 on your pick.</div>
<div class="b voted">Lupa Trattoria<span class="tap">👍 3</span></div>
<div class="b me">Booking it 🙌</div>
</div>
<section class="block" aria-labelledby="for-groups">
<h2 id="for-groups">Built for groups, not one person.</h2>
<p class="sub">Other assistants work for whoever's typing. Nod works for everyone in the chat, and anyone can use it.</p>
<div class="features">
<div class="feat"><p class="tag">Decide</p><code>@Nod let's vote</code><p>Each option as its own message. Everyone taps 👍 and Nod calls it.</p></div>
<div class="feat"><p class="tag">Book</p><code>@Nod book it for 6 at 8</code><p>Reservation links with the party size and time already filled in.</p></div>
<div class="feat"><p class="tag">Pay</p><code>@Nod split this</code><p>Post the receipt. One message says who pays whom.</p></div>
<div class="feat"><p class="tag">Remember</p><code>@Nod remember Sarah hates early flights</code><p>The group's notes, tab and plans, kept in the chat.</p></div>
</div>
</section>
<section class="block" aria-labelledby="how">
<h2 id="how">Up and running in a minute.</h2>
<ol>
<li>Add Nod to any iMessage group</li>
<li>Tag @Nod when the group needs something</li>
<li>Everyone taps to vote and pay</li>
</ol>
</section>
<section class="block" aria-labelledby="get">
<h2 id="get">Get ${inlineLogo()}</h2>
<form class="join" id="signup" method="post" action="/signup">
${d.error ? `<p class="err" role="alert">${esc(d.error)}</p>` : ""}
<input class="field" name="name" type="text" placeholder="First name" autocomplete="given-name" autocapitalize="words" maxlength="30" aria-label="First name" value="${esc(d.values?.name ?? "")}">
<input class="field" name="phone" type="tel" inputmode="tel" placeholder="Mobile number" autocomplete="tel" maxlength="20" required aria-label="Mobile number" value="${esc(d.values?.phone ?? "")}">
<div class="hp" aria-hidden="true"><input name="website" type="text" tabindex="-1" autocomplete="off"></div>
<button class="btn" type="submit" aria-label="Get Nod">Get ${buttonLogo()}</button>
<p class="consent">By tapping Get Nod, you agree to get texts from Nod at this number about your sign-up and Nod, including automated texts. Agreeing isn't a condition of any purchase. Msg frequency varies. Msg &amp; data rates may apply. Reply STOP to cancel, HELP for help. See our <a href="/terms">Terms</a> and <a href="/privacy">Privacy</a>.</p>
</form>
</section>
${textHref ? `<p class="more"><a href="${esc(textHref)}">Or just text Nod</a></p>` : ""}
<p class="more"><a href="/join">Have an invite code?</a><span aria-hidden="true">·</span><a href="${esc(inviteHref)}">Invite a friend</a></p>
<p class="fine">Your number is your account, so there's no password or app. Nod only sees a group's messages after it's added, never spends without the group's OK, and never holds your money. ${esc(AFFILIATE_DISCLOSURE)}</p>
<p class="more"><a href="/privacy">Privacy</a><span aria-hidden="true">·</span><a href="/terms">Terms</a></p>
`, { title: "Nod · The AI agent for group chats", description, image: base ? `${base}/nod-logo.png` : undefined });
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
