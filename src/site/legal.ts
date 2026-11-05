// /privacy and /terms. DRAFTS: written to match what Nod actually does (CLAUDE.md), for the
// user or a lawyer to review before launch. Company name, contact email and governing law come
// from settings; until they're set the pages show [bracketed] placeholders, so an unreviewed
// page is obvious. Keep these in step with the product: if Nod starts storing or sharing
// something new, these pages change in the same commit.

import { esc } from "../web/theme";
import { inlineLogo, sitePage } from "./shell";

export interface LegalSettings {
  /** The company that runs Nod (NOD_LEGAL_NAME). */
  company?: string;
  /** Where people write for help, deletion or legal notices (NOD_CONTACT_EMAIL). */
  email?: string;
  /** State whose law governs the terms (NOD_LEGAL_STATE). */
  state?: string;
  /** Last updated, YYYY-MM-DD (NOD_LEGAL_UPDATED). */
  updated?: string;
}

export function legalSettings(env: NodeJS.ProcessEnv = process.env): LegalSettings {
  const v = (k: string) => env[k]?.trim() || undefined;
  return { company: v("NOD_LEGAL_NAME"), email: v("NOD_CONTACT_EMAIL"), state: v("NOD_LEGAL_STATE"), updated: v("NOD_LEGAL_UPDATED") };
}

/** Settings still missing (the health check lists them). */
export function missingLegalSettings(s: LegalSettings): string[] {
  return [!s.company && "NOD_LEGAL_NAME", !s.email && "NOD_CONTACT_EMAIL", !s.state && "NOD_LEGAL_STATE", !s.updated && "NOD_LEGAL_UPDATED"].filter(
    (x): x is string => !!x,
  );
}

function fill(s: LegalSettings) {
  const email = s.email ? `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : "[contact email]";
  return { company: esc(s.company ?? "[Company name]"), email, state: esc(s.state ?? "[State]"), updated: esc(s.updated ?? "[date]") };
}

function page(title: string, heading: string, body: string, updated: string): string {
  return sitePage(
    `<h1>${heading}</h1>
<p class="sub">Last updated ${updated}</p>
<article class="legal">${body}</article>
<p class="more"><a href="/">Home</a><span aria-hidden="true">·</span><a href="/privacy">Privacy</a><span aria-hidden="true">·</span><a href="/terms">Terms</a></p>`,
    { title, description: `${title} for Nod, the assistant for group chats.` },
  );
}

export function renderPrivacy(settings: LegalSettings = legalSettings()): string {
  const f = fill(settings);
  return page(
    "Privacy",
    `${inlineLogo()} privacy`,
    `<p>Nod is an assistant that lives in your group chats. This page says what Nod keeps, why, who else sees it, and how to have it deleted. Nod is run by ${f.company} ("we").</p>

<h2>The short version</h2>
<ul>
<li>Nod reads a group's messages only after someone adds it, and keeps at most the last 200 messages or 30 days of them, whichever is less.</li>
<li>Your phone number is your account. There's no password and no app.</li>
<li>We don't sell your information and don't show ads.</li>
<li>Anyone can stop Nod reading their messages, and "@Nod forget this chat" deletes a group's saved messages and notes.</li>
<li>No mobile information is shared with third parties or affiliates for marketing or promotional purposes.</li>
</ul>

<h2>What Nod keeps</h2>
<ul>
<li><strong>Your number and name.</strong> Your phone number, and your first name if you give it (on our website, in a text, or when someone in a group tells Nod who you are).</li>
<li><strong>Group messages.</strong> Messages, photos and reactions in group chats Nod is in, from after it joined. Nod checks each one to see whether it's being called, and keeps recent ones (at most 200 or 30 days per group) so it understands the conversation when it is. Nod never sees anything from before it joined.</li>
<li><strong>Private messages</strong> you send Nod, and contact cards you share with it.</li>
<li><strong>What the group asks Nod to keep:</strong> notes ("Mike's vegetarian"), votes, date polls, links and options people post, searches, bookings, calendar events, and the tab of who paid for what, including receipt photos and what Nod read from them.</li>
<li><strong>Payments.</strong> When you pay or collect money through Nod, our payment processor, Stripe, handles your card and bank details. We keep Stripe's reference ids, amounts and status, never your full card number.</li>
<li><strong>Your Venmo username,</strong> if you give it to Nod, so tab summaries can link to it.</li>
<li><strong>Website sign-ups:</strong> the name and number you enter, and a scrambled (hashed) form of your network address, used only to stop the form being abused.</li>
</ul>

<h2>How Nod uses it</h2>
<p>Only to do what people in the chat ask: answer when called, run votes and polls, find and book places, keep and settle the tab, send invites and reminders, and keep Nod working and secure. Nod speaks in a group only when someone calls it.</p>

<h2>Who else sees it</h2>
<p>We share information only as needed to run Nod, with companies that work for us:</p>
<ul>
<li><strong>Sendblue</strong> delivers Nod's texts and iMessages.</li>
<li><strong>Anthropic</strong> provides the AI (Claude) that reads the conversation when Nod is called and writes its replies. Web searches see only what was asked for (the place, dates, group size and dietary needs), never the chat.</li>
<li><strong>Stripe</strong> processes payments.</li>
<li><strong>Supabase, Vercel and Inngest</strong> store data and run our servers and scheduled reminders.</li>
<li><strong>Booking partners.</strong> When your group approves a booking Nod makes for you, the venue or platform gets the name and number it's booked under.</li>
<li><strong>Affiliate programs.</strong> Some links Nod sends earn us a commission when you book. Those links carry an anonymous label for the link itself, never your name, number or messages.</li>
</ul>
<p>We may also share information if the law requires it, to protect people's safety, or as part of a sale or merger of our business, in which case this policy keeps applying.</p>

<h2>Your choices</h2>
<ul>
<li><strong>Stop Nod reading your messages</strong> in a group: say "@Nod stop reading my messages", or use your settings page (ask Nod for your settings link). You can still call Nod, vote and pay.</li>
<li><strong>Forget a chat:</strong> "@Nod forget this chat" deletes that group's saved messages, notes, open questions and receipt photos. The tab, bookings and payments stay, so nobody loses track of money.</li>
<li><strong>Stop texts:</strong> reply STOP and Nod won't text you privately until you reply START. Reply HELP for help.</li>
<li><strong>Remove Nod</strong> from a group like any contact.</li>
<li><strong>Delete your account</strong> or get a copy of your information: email ${f.email} from your number's owner, and we'll do it within 30 days, except records the law requires us to keep, such as payment records.</li>
</ul>

<h2>How long we keep it</h2>
<p>Group messages: at most 200 per group or 30 days, whichever is less. Everything else: until you or your group deletes it, or you ask us to delete your account, except payment records we must keep by law.</p>

<h2>Children</h2>
<p>Nod isn't for anyone under 13, and paying or collecting money through Nod is only for adults. If you think a child has given us information, email ${f.email} and we'll delete it.</p>

<h2>Security</h2>
<p>We use encryption in transit, private links that can't be guessed, and access limited to what each part of Nod needs. No system is perfectly secure; if something goes wrong that affects you, we'll tell you.</p>

<h2>Changes and contact</h2>
<p>If we change this policy in a way that matters, we'll update the date above and, for big changes, tell you by text. Questions: ${f.email}.</p>`,
    f.updated,
  );
}

export function renderTerms(settings: LegalSettings = legalSettings()): string {
  const f = fill(settings);
  return page(
    "Terms",
    `${inlineLogo()} terms`,
    `<p>These terms are an agreement between you and ${f.company} ("we") about using Nod, the assistant for group chats. By texting Nod, adding it to a group, or signing up on our website, you agree to them.</p>

<h2>What Nod does</h2>
<p>Nod helps a group find, decide on, book and split the cost of things. It answers when someone calls it, runs votes, sends links to book, keeps a tab of who paid what, and, where set up, collects payments. Its replies are written by AI and can be wrong: check prices, times and details with the venue or platform before you rely on them.</p>

<h2>Who can use it</h2>
<p>You must be at least 13 to use Nod, and an adult (18, or the age of majority where you live) to pay or collect money through it. You're responsible for the number you use and what's sent from it. Adding Nod to a group and starting groups may need an invite; anyone already in a group with Nod can use it there.</p>

<h2>Texts from Nod</h2>
<ul>
<li>Program: Nod, an assistant for group chats. Nod texts you when you sign up, when you or your group ask it for something, and with reminders the group set up (votes closing, payments due).</li>
<li>Message frequency varies. Message and data rates may apply.</li>
<li>Reply STOP to stop private texts from Nod, START to turn them back on, and HELP for help. Messages in group chats come from Nod only when someone in the group calls it.</li>
<li>By entering your number on our website, you agree to get these texts, including ones sent automatically. Agreeing isn't a condition of any purchase.</li>
<li>Carriers aren't responsible for delayed or undelivered messages.</li>
</ul>

<h2>Payments</h2>
<p>Payments through Nod are processed by Stripe and go straight to the person collecting them; we never hold your money. Your card is authorized when you commit and charged only once the group is fully funded and has approved the amount; holds that aren't used are released. Payments are between members of the group. Stripe's terms apply, and disputes about a charge go through your card issuer. The tab Nod keeps is a record to help your group, not a bill from us.</p>

<h2>Bookings and links</h2>
<p>Nod links to restaurants, rentals, tickets and other businesses, and may book through partners after your group approves the exact terms. The business or platform you book with is responsible for the booking, its prices, availability, deposits and cancellation rules, and its own terms apply. Some links earn us a commission when you book; this never changes what you pay or which places Nod suggests.</p>

<h2>Using Nod fairly</h2>
<p>Don't use Nod to harass people, send spam, break the law, get around its limits, or interfere with how it works. Don't add Nod to groups where people don't want it; anyone can remove it. We may suspend access that breaks these terms.</p>

<h2>Your content</h2>
<p>You keep what you send. You let us store and process it to run Nod for your group, as the privacy policy describes.</p>

<h2>No warranty</h2>
<p>Nod is provided "as is", without warranties of any kind, to the extent the law allows. We don't promise it will always be available, error-free or right.</p>

<h2>Limits on liability</h2>
<p>To the extent the law allows, we aren't liable for indirect or consequential losses, or for what businesses you book with do, and our total liability for any claim is limited to the greater of what you paid us in the past 12 months or $100. Some places don't allow these limits, so they may not apply to you.</p>

<h2>Changes and ending</h2>
<p>We may update these terms; if a change matters, we'll update the date above and tell you by text. You can stop using Nod any time by replying STOP and removing it from your groups.</p>

<h2>Law and contact</h2>
<p>These terms are governed by the laws of ${f.state}, USA. Questions or notices: ${f.email}.</p>`,
    f.updated,
  );
}
