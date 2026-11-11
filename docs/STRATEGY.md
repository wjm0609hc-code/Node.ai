# Nod strategy (agreed Nov 11, 2026)

This is the business and go-to-market direction for Nod. It decides what we build next and what we leave alone. Product rules in `CLAUDE.md` still apply; where this file and `CLAUDE.md` seem to disagree, ask before changing behaviour.

## The one-line version

Nod is free for groups. It gets a group chat from "we should do something" to booked, keeps the money even, and the businesses we send groups to pay us.

## Business model: users pay $0

We dropped the idea of charging the group (a per-person trip fee, about $25 a head, was the wrong model: people won't pay extra just to use Nod). Nod makes money from the supply side and from payments people never see:

1. **Booking and activity commissions (main line).** Boat rentals, private chefs, golf, ski rentals, tours, nightlife tables, tickets. These usually pay referral commissions, often 5–20%, and on a group weekend they add up to more than the house. This is the existing affiliate work (`src/affiliates/`) and the booking-partner adapters (step 9).
2. **Lodging affiliates.** Vrbo/Expedia Group, Booking.com, hotels. Airbnb has no affiliate program we can rely on.
3. **Restaurant and venue deals, later.** Once Nod steers groups of 8–12, venues will pay for group bookings, especially on slow nights.
4. **Interchange, later.** Only if we ever issue a trip card (see "Parked").

Illustration only: a Tahoe weekend with a $5,000 house plus about $3,000 of boat, chef and golf booked through Nod. At around 10% on activities plus a small cut on the house, Nod makes roughly $300–400, and the group pays nothing extra. Real rates depend on the partners we sign.

Rule that follows: **never rank picks by commission** (already in `CLAUDE.md`). Monetization must never make Nod's recommendations worse.

## Who we're for first (go-to-market wedge)

Nod stays a general group-chat agent (`CLAUDE.md`: never assume a trip). But the first customers we chase are **organizers of bachelor and bachelorette parties and similar group weekends**:

- One stressed person owns the problem (best man / maid of honor).
- Big spend: roughly $1,500–3,000 a head for 8–15 people, with lots of bookable extras (where commissions live).
- A hard deadline, so people actually commit.
- It spreads: every guest is in other weddings.
- Founder's network: NYC/Boston finance crowd, late 20s to early 30s.

This is a sales and testing focus, not a product restriction. Don't make any feature trip-only.

## The product: one simple loop

Every request follows the same four steps, so people learn it once:

**Ask → options → vote → done.**

- "@Nod find us a house in Tahoe" → options as cards → tapback vote → booking link (or partner booking) → calendar invite.
- "@Nod dinner Friday 8pm, 10 of us" → options → vote → booked → invite.
- Payment shows up only when there's a big upfront cost.

Decisions made in the founder conversation:

- **Anyone can add Nod to an existing group chat and it picks up from there.** No organizer-first setup step. (Matches `CLAUDE.md` "Getting Nod into a group".) An organizer only matters at booking time: whoever's name goes on the reservation.
- **Speak only when called** stays non-negotiable. It's our counter-position to ambient competitors (Alfi, Boba) and a trust feature around money.
- **Receipts during a trip:** someone drops a receipt photo and says "@Nod split this". Nod adds it to the running tab. People settle once at the end with one payment each, not one request per receipt. (Built: step 11.) Nod should not try to pull purchases from anyone's bank or card.

## Payments: keep it as light as possible

Goal: nobody fronts the whole house and chases Venmos, and Nod never holds money (rule 5).

- **Simplest version first.** For early tests, payments can be prefilled Venmo / Apple Cash / PayPal requests plus Nod tracking who has paid. It costs nothing and needs no approvals. Our Stripe flow (step 10) stays, but watch the cost: card processing runs about 3% per payment, and with the free-to-users model nobody is paying a fee to cover it.
- **Open question for the next session:** with direct charges on the payee's Stripe account, the person collecting currently absorbs Stripe's fees. Decide whether to (a) offer a free Venmo/Apple Cash path for settle-up and collections, (b) show the fee to payers, or (c) eat it. Lay out the options before changing anything.
- **Never build our own payments rails.** Holding money ourselves would make Nod a money transmitter: state licenses in ~49 states, surety bonds, about $1–1.5M and ~2 years, plus AML compliance. The float is worth almost nothing anyway (about $3 on a $4,000 house held a week).

## Parked (don't build unless asked)

These came up and were deliberately set aside to keep Nod simple:

- **Virtual trip card (Stripe Issuing)** that pays for the house from pooled money in the lead guest's Apple Wallet. Needs Stripe sales approval and raises custody questions. Revisit only if testers keep saying "I hate fronting the house".
- **Trip kitty with auto-refill** (pay once upfront, agree to a cap, auto top-ups, exact settle at the end). Good design if the card ships; not now.
- **Charging people after the fact** for shared spending. Means Nod fronts money, which is effectively lending. Never.
- **Per-head or per-trip fees to users.**
- **Automating Airbnb/Vrbo searches or bookings.** Airbnb's terms forbid bots and automated access. Rentals stay a hand-off: whoever books uses their own account (as built).

## Platform risks to keep in mind

- **iMessage.** Apple has no public iMessage API; we run through Sendblue. Apple's approved path (Messages for Business, used by Poke) is for 1:1 business chats a customer starts, not friends' group chats. Risk: spam controls can suspend lines. Mitigate: Nod only replies, never cold-messages; spread users across lines; keep anything important (pay pages, trip details) on our web pages so a blocked number doesn't kill a trip; SMS/RCS fallback.
- **Airbnb could build this.** Airbnb launched split payments in 2017 (via its Tilt acquisition) and could add a split button again. Our moat is the layer above: an agent in the chat that plans the whole weekend across every site, runs the vote and handles day-of logistics.

## Competitive landscape (Nov 2026)

Closest: **Alfi** (text.ai, YC; ambient group-chat AI, own app, Yelp reservations, Venmo/PayPal settle-up), **Boba** (SMS group chats, plans, books, splits), **wabi** (a16z; agentic messenger with group chats and generated mini-apps), **Jarvie** ($8.3M; iMessage group agent for dinners and trips), **Anuma/Coco** (add to any iMessage/SMS group). 1:1 iMessage agents: Instinct, Poke, folk, Caddy, szn. Our difference: invoke-only, and we finish the job (booking, money, tab), focused on group weekends first.

## How we test (next 30 days)

From YC-style advice the founder agreed with:

1. **Narrow:** 20 bachelor/bachelorette organizers through friends with 2027 weddings (Nov–Feb is peak engagement season, so spring parties get planned now).
2. **In person / white glove:** coffee with each organizer; the founder sits in on the first trips and quietly fills any gap the agent can't. Every gap is roadmap.
3. **7-day experiments, kill what fails.** One test a week, one number each:
   - Core: share of groups that go from options to booked (and, where money is collected, to paid within 48 hours).
   - Hook: "Plan the bachelor in one thread" vs "Nobody fronts the house".
   - Channel: warm intros vs wedding-party chats vs rental-host partnerships.
   - Revenue: share of trips that book at least one commissionable extra (boat, chef, golf, tickets).

Track the whole chain per trip: options shown → vote → booked → paid → extras booked.
