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

Add these two files to `public/` and redeploy, or host them elsewhere and set `NOD_LOGO_URL` and
`NOD_HOWTO_VIDEO_URL`:

- `nod-logo.png`: square, at least 512×512. It's Nod's contact photo and the photo on groups Nod starts.
- `add-nod.mp4`: the five-second screen recording of adding Nod to a group (tap the group name,
  Add Contact, type Nod).

## 9. Check everything

```
npm run check
```

Or open `https://<your app>/api/health?token=<HEALTH_TOKEN>`. Every line should be ✓
(or "off" for payments if you skipped Stripe). Without the token, the page only says
`{"ok": true}`, which is what you'd point an uptime monitor at.

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

## Before real users

- Work through the "To verify" items in `CLAUDE.md` (Stripe Connect settings, booking-link
  parameters, delivery links, Sendblue media URLs).
- Switch Stripe to live keys only after a full test run: request, everyone pays, capture, settle-up.
- Watch Inngest's runs for failed replies during the first week.
