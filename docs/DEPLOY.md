# Deploying Nod

This is the path from nothing to Nod answering in a real iMessage group. It takes an
afternoon, most of it waiting on accounts. Service dashboards change their wording
often, so a button may be named slightly differently from what's written here.

You'll create five accounts: **Supabase** (database), **Vercel** (hosting),
**Inngest** (scheduled jobs and reply retries), **Sendblue** (Nod's iMessage number)
and **Anthropic** (Claude). **Stripe** is optional: payments stay off until it's set up.

Keep a scratch `.env` file in the project folder as you go (copy `.env.example`).
Never commit it. The same values go into Vercel at the end.

## 1. Make two secrets

Run this twice and keep both results:

```
openssl rand -hex 24
```

- The first one is `SENDBLUE_WEBHOOK_SECRET` (proves webhook calls really come from Sendblue).
- The second one is `HEALTH_TOKEN` (lets you see the full health checklist).

## 2. Database (Supabase)

1. Create a project. Pick the region closest to where Vercel will run (US East is the default for both).
2. Open **Connect** and copy two connection strings:
   - **Transaction pooler** (port 6543): this is `DATABASE_URL`. The app uses it.
   - **Session pooler** (port 5432) or the **direct connection**: this is `DATABASE_MIGRATION_URL`. Migrations need it.
3. Nothing to run: every Vercel deploy creates or updates the tables first (the `vercel-build`
   script runs the migrations, then builds the app). Make sure both strings are in Vercel's
   environment variables before the first deploy. From a computer, `npm run db:migrate` does the same.

From now on, schema changes ship as new migration files (`npm run db:generate -- --name what_changed`),
never by editing `drizzle/0000_init.sql`. `npm run db:check` fails if the schema and migrations disagree.

## 3. Claude (Anthropic)

Create an API key in the Anthropic Console and set `ANTHROPIC_API_KEY`. Set up billing on the account;
replies, searches and receipt reading all use it. Optional model settings are in `.env.example`.

## 4. iMessage number (Sendblue)

1. Sign up, get a number, and create API credentials.
2. Set `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY` and `SENDBLUE_FROM_NUMBER` (Nod's number as `+15551234567`).
3. The webhook is registered in step 7, once the app has a URL.
4. **Nod's name and picture in iMessage.** So that every new chat shows "Maybe: Nod" with the
   logo (before anyone saves the contact), the line's Apple ID needs iMessage's *Share Name and
   Photo* turned on with the name **Nod**, the photo `public/nod-logo.png`, and sharing set to
   **Anyone** (Messages → Settings → Share Name and Photo on the Mac that sends). Sendblue's Macs
   send for you, so ask Sendblue support to set this on your number and send them the PNG.
   This isn't in their API.

## 5. Hosting (Vercel)

1. Import the GitHub repository as a new project. The defaults for Next.js are right.
2. Add every variable from your `.env` under **Settings → Environment Variables** (Production).
3. Deploy, then set `NOD_APP_URL` to the production URL (for example `https://nod.example.com`,
   no trailing slash) and redeploy.

Plan note: replies that search the web can take over a minute. The job endpoint asks for up to
5 minutes (`maxDuration = 300` in `src/app/api/inngest/route.ts`), which needs a paid Vercel plan.
On the free plan, long replies may be cut off at 60 seconds.

## 6. Jobs (Inngest)

1. Install the Inngest integration for Vercel (or create an app in Inngest and copy the keys).
2. Make sure `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are set in Vercel, then redeploy.
3. In Inngest, sync the app at `https://<your app>/api/inngest`. You should see six functions:
   reply, vote-timeline, booking-reminder, collection-timeline, event-reminder and trip-wrap.

## 7. Connect Sendblue to the app

With `.env` filled in (including `NOD_APP_URL`):

```
npm run sendblue:webhook
```

This registers `https://<your app>/api/inbound?token=…` as Nod's receive webhook. Running it
again is harmless. (Or add the same URL by hand in Sendblue's dashboard.)

## 8. Onboarding media

`public/nod-logo.png` is already in the repo (`npm run logo` redraws it from `src/site/logo.ts`).
It's the photo on groups Nod starts and the iMessage photo in step 4. The contact card at
`/nod.vcf` embeds the same logo itself, since iPhones ignore contact photos given by link.
Add the video to `public/` and redeploy, or host files elsewhere and set `NOD_LOGO_URL` and
`NOD_HOWTO_VIDEO_URL`:

- `add-nod.mp4`: the five-second screen recording of adding Nod to a group (tap the group name,
  Add Contact, type Nod).

## 9. Check everything

```
npm run check
```

Or open `https://<your app>/api/health?token=<HEALTH_TOKEN>`. Every line should be ✓
(or "off" for payments if you skipped Stripe). Without the token, the page only says
`{"ok": true}`, which is what you'd point an uptime monitor at.

The stats page is at `https://<your app>/admin/stats?token=<HEALTH_TOKEN>` (add `&days=30` or
`&days=90` for longer). It shows how many cards Nod sent and how many people opened, by link type,
site (with whether an affiliate program covers it), category and pick position. To give it its own
token, set `NOD_STATS_TOKEN`. Without a valid token the page is a plain 404.

## 10. Let yourself in

Nod is invite-only, so the first person needs a code:

```
npm run invites -- codes 1
```

Text the code to Nod's number from your phone. You should get the welcome, Nod's contact card,
the how-to video and the privacy note. Then add Nod to a group of three or more iPhones and tag it.

While you're at it, capture Sendblue's payloads as described under "Come back to" in `CLAUDE.md`.

## 11. Payments (optional, Stripe)

1. In Stripe (test mode first), turn on **Connect**.
2. Set `STRIPE_SECRET_KEY` (`sk_test_…`) and `STRIPE_PUBLISHABLE_KEY` (`pk_test_…`).
3. Add a webhook endpoint at `https://<your app>/api/stripe` that listens to **events on connected
   accounts**, for `payment_intent.*` and `account.updated`. Copy its signing secret into
   `STRIPE_WEBHOOK_SECRET`.
4. Redeploy and run `npm run check` again. Payments should say "Stripe test mode".
5. Try it in a group: "@Nod collect $5 each for snacks". You'll get a payout setup link first,
   then everyone gets a pay link. Stripe's test card is 4242 4242 4242 4242.

## 12. Affiliate links (optional, earns commissions)

Sign up for each program, then add its setting in Vercel and redeploy. Links to that program's
sites then carry your tag, wherever Nod sends them (cards, the search results page, delivery links).
Nothing changes for people, and unset programs pass through untouched.

Start with the catch-all network, since one setting covers most shops and travel sites:

- `NOD_AFFILIATE_FALLBACK`: sign up for Skimlinks or Sovrn Commerce, then paste their link with
  `{url}` where the destination goes and `{sub}` where Nod's anonymous label goes, e.g.
  `https://go.skimresources.com/?id=YOUR_ID&xs=1&url={url}&xcust={sub}`. Direct programs below win
  when both cover a site (they usually pay more, since the network keeps a share).
- `NOD_AFFILIATE_EXTRA`: any other program, without a code change, as JSON:
  `[{"name":"Agoda","domains":["agoda.com"],"tag":"1234","param":"cid"}]`, or with `"link"` holding
  a tracking link with `{url}`. Check each program's own parameter names in its dashboard.
- `NOD_AFFILIATE_PROMOS`: promo codes a program issued to Nod, as JSON:
  `[{"domains":["seatgeek.com"],"code":"NOD10","offer":"$10 off your first order","until":"2027-06-30"}]`.
  Cards for that site then end with "Code NOD10: $10 off your first order." (also on the card's page
  and the search results page). A code credits Nod whenever it's used, on any device and any time,
  so it catches purchases cookies miss. Only add codes the program actually gave you; drop or
  update `until` when they expire.

**Before joining a program, ask it these questions** (they decide how much of what Nod sends you
actually get paid for):

1. **Cookie window:** how many days after a tap does a purchase still count? Prefer 30+ days;
   group purchases often happen a week or two after the chat.
2. **Server-side tracking:** do you record clicks on your servers (sometimes called first-party or
   server-to-server tracking), or only with browser cookies? On iPhones, Safari deletes
   script-set cookies after 7 days, so cookie-only tracking misses later purchases.
3. **Logged-in, cross-device credit:** if someone taps on their phone and buys on a laptop while
   logged into their account, do we get credit?
4. **App purchases:** if the tap opens your app (or they buy in it later), is it credited? Which
   app-tracking service do you use (Branch, AppsFlyer, Adjust)?
5. **Promo codes:** can you issue Nod a code that credits us whenever it's used?
6. **Last click:** if they click another partner's link after ours, who gets credit? Any
   "first click" or split credit?
7. **Texting and private messages:** are links in group chats and private texts allowed? Describe
   Nod honestly: links sent in group chats only when people ask.
8. **Sub-IDs:** which parameter carries our anonymous label (so reports show which cards earn)?
9. **When it's final and when you pay:** after the stay, show or tour? Payment schedule, minimum
   payout, and how cancellations are taken back.
10. **Rate and bonuses:** the base commission, volume tiers, and whether new customers pay more.

- Reports: every link carries an anonymous label (`card-<id>`, `search` or `delivery`; never
  anything about a person), so the programs' reports show which cards earn. Booking.com gets it as
  `label`, Amazon as `ascsubtag`, GetYourGuide as `cmp`, networks wherever `{sub}` goes.

| Program | Setting | What to put in it |
|---|---|---|
| Booking.com | `NOD_AFFILIATE_BOOKING` | Your affiliate ID (the `aid`) |
| Expedia Group (Expedia, Vrbo, Hotels.com) | `NOD_AFFILIATE_EXPEDIA` | A tracking link with `{url}` where the destination goes |
| Viator | `NOD_AFFILIATE_VIATOR` | Your partner ID (the `pid`) |
| GetYourGuide | `NOD_AFFILIATE_GETYOURGUIDE` | Your partner ID |
| OpenTable | `NOD_AFFILIATE_OPENTABLE` | Your referral ID (the `ref`) |
| SeatGeek | `NOD_AFFILIATE_SEATGEEK` | Your affiliate ID (the `aid`) |
| StubHub, Ticketmaster, Instacart, DoorDash, Uber Eats | `NOD_AFFILIATE_STUBHUB` and so on | A tracking link with `{url}` (these track through networks like Impact) |
| Amazon | `NOD_AFFILIATE_AMAZON` | Your Associates tag |

Any program can use the `{url}` form instead if its network gives you a deep-link template, e.g.
`https://partner.example/c/123/456/789?u={url}`. Check each program's link format in its dashboard
before relying on it; the parameter names in `src/affiliates/affiliates.ts` come from public links.
`npm run check` (or `/api/health?token=…`) lists the programs that are switched on.

## Sign-up settings

- `NOD_GROUP_SIGNUP`: leave blank so anyone in a group with Nod can get their own access (tap ❤️ on
  Nod's intro, or text Nod). Set it to `waitlist` if you need to slow growth; they join the waitlist
  instead, and `npm run invites -- release 25` lets people in.
- `NOD_SIGNUP_SALT`: any long random string. It hashes sign-up IP addresses for the rate limits.
- The home-page form makes Nod text people first. Messages to numbers that aren't on iMessage go
  out as SMS, which in the US needs the number registered for business texting (A2P 10DLC or
  toll-free verification). Ask Sendblue what your line needs. Nod honours STOP and START itself.

## Before real users

- Work through the "To verify" items in `CLAUDE.md` (Stripe Connect settings, booking-link
  parameters, delivery links, Sendblue media URLs).
- Switch Stripe to live keys only after a full test run: request, everyone pays, capture, settle-up.
- Watch Inngest's runs for failed replies during the first week.
