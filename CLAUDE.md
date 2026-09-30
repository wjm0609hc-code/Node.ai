# CLAUDE.md — Nod group-chat agent

Read this file before every session. It defines what we're building, the rules the product must follow, and how to work in this repo.

## What we're building

An AI agent that people add to an iMessage group chat (WhatsApp later). It stays silent unless someone calls it. When called, it helps the group find, decide on, book and pay for things: rentals, restaurants, things to do, deliveries, tickets. It can search the web for options when asked. It keeps a running tab of who owes what.

There is no app. The only interfaces are the group chat, private messages to individuals, and one small web page for payments and settings.

## Product rules (never break these)

1. **Speak only when called.** Never reply to ordinary conversation, even if it's about something Nod could help with. See "Calling Nod" below for the exact trigger rules. When unsure, stay silent.
2. **Short replies.** One message per action. Put long details behind a link to the web page.
3. **Nudge privately.** Payment reminders and anything about one person's money go to that person directly, never to the group.
4. **Never spend without approval.** No charge is captured unless the group's spending rules are met and the group has been told the amount. Default rule: the organizer approves; anything over $200 per person needs three approvals.
5. **Never hold money.** Payments run through Stripe Connect with the organizer as the connected account. Cards are authorized when someone commits and captured only once the group is fully funded. Our platform never has custody of funds.
6. **Everyone in the chat can use it.** Only people with access can add it to a new group, but anyone already in the group can vote, pay, and ask questions.
7. **Privacy.** Store only the recent messages needed for context (default: last 200 messages or 30 days per group, whichever is smaller). Any member can opt out of having their messages read. "@Nod forget this chat" deletes the group's stored messages and notes.

## Calling Nod

Nod is a real English word, so detection has two tiers, plus a narrow follow-up window after Nod asks someone a question.

**Certain triggers (always respond):**
- `@Nod` anywhere in the message (case-insensitive), including iMessage mentions of Nod's contact
- `Nod` as the first word of a message, optionally followed by punctuation ("Nod, book the 8pm", "Nod book it")
- A greeting directly before the name anywhere in the message: "hey Nod", "yo Nod", "hi Nod", "ok Nod"
- An inline reply to one of Nod's own messages
- Any private (1:1) message to Nod

**Ambiguous (check before responding):**
- "nod" appears anywhere else in the message ("he gave me the nod", "I'll nod along")
- Run a fast, cheap classification call to Claude: "Is this message addressed to the assistant named Nod? Answer yes or no." Respond only on a clear yes.

**Follow-up answers (no tag needed):**
When Nod's reply asks one specific member a question only they can answer ("Jake, what's the nightly price?", "Sarah, how much does Mike owe you?"), that person can just answer. Nod asking is effectively calling them back. The limits keep this from ever looking like Nod joining ordinary conversation:
- Only the person Nod asked. Anyone else still needs to call Nod.
- Only within 10 minutes, and only their next two messages.
- A fast Claude check confirms the message actually answers the question ("$310" does; "lol one sec" doesn't). Nod responds only on a clear yes.
- The window closes once they answer, when they call Nod directly or reply inline, or after two messages that aren't answers.
- Never in private chats (not needed), and never for members who opted out of having their messages read (they can still tag Nod).
Windows open two ways, stored in `pending_questions`: automatically for the person who called Nod whenever Nod's reply asks a question (a "?" outside any link, e.g. "Want me to find dinner spots too?" → "Yes please"), and for a different member when Claude calls `expect_answer_from(member)`. This matters most in SMS groups, which have no inline replies.

**Never a trigger:**
- Tapback reactions alone (they count as votes, not calls)
- Messages from Nod itself

Put all of this in one function, `isAddressedToNod(message, context)`, with a thorough test suite: true positives, false positives ("nodding", "nod off", "gave me the nod"), capitalization variants, punctuation, mentions, and replies.

## Getting Nod into a group

**Primary path: someone adds Nod to an existing iMessage group.** Any member can do it (group name → Add Contact → "Nod"). Apple only allows this when the group has at least three people and everyone is on iMessage.

### Personal setup (private 1:1 thread, first contact)
After the invite code is redeemed, Nod's first private messages:
1. A short welcome and its contact card (vCard via Sendblue) with the Nod name and logo photo, so it's saved as "Nod" and never looks like an unknown number.
2. A five-second screen recording showing how to add Nod to a group: tap the group name, tap Add Contact, type Nod.
3. A one-line privacy note.
Resend the contact card on request ("@Nod your card", "save contact", "add me").

### When Nod is added to a group
Detect the join event (or the first inbound message from a new `group_id`) and send exactly one introduction message:
- Who added it: "Will added me."
- What it does and how to call it: "Tag @Nod when you need me. I stay quiet otherwise."
- The catch-up prompt: "I can't see anything from before I joined, so re-send any links you're weighing and I'll compare them."
- How to opt out or remove it: "@Nod forget this chat," or remove Nod like any contact.
- Its contact card.
It then stays silent until called.

Nod has no access to messages sent before it joined. Never imply otherwise.

Record who added Nod (`groups.added_by_user_id`). If the person who added it does not have access (no invite), Nod still introduces itself but tells them privately how to get access; see the invite rules.

### Fallback: Nod creates the group
For groups that can't add people (fewer than three people, or any member not on iMessage), the user texts Nod privately: "Start a group for Tulum with Jake, Sarah, and Mike" (shared contacts or names Nod already knows). Nod creates the group via Sendblue's group API, names it and sets a photo where the line supports it, and sends the same introduction. If Nod is added to a group where it can't operate, it replies privately to the person who added it and offers this fallback.

## Stack

- TypeScript, Node 20+, Next.js (App Router) deployed on Vercel
- Postgres on Supabase, Drizzle ORM
- Inngest for scheduled and delayed jobs
- Anthropic SDK (Claude) with tool use
- Stripe (Connect, PaymentIntents with `capture_method: manual`)
- Sendblue for iMessage (group messaging API; `group_id` identifies the chat)
- Vitest for tests

## Architecture

```
Sendblue webhook → /api/inbound
  → store message (group_id, sender, text, media, reactions)
  → isAddressedToNod()? if not, stop.
  → build context: recent messages + group notes + open decisions + tab
  → Claude with tools → tool calls → actions
  → send reply (group or private) via messaging adapter
Inngest jobs: decision deadlines, payment reminders, auth-expiry checks, day-of messages
Web page: /pay/[token], /connect/[token] (payout setup), /group/[id]/settings, /join (invite code entry); Stripe webhook at /api/stripe
```

Keep messaging behind an adapter interface (`MessagingProvider`) with implementations for Sendblue and a local simulator. WhatsApp will be added later without touching business logic.

## Data model (starting point)

- `users` — phone, name, stripe_customer_id, stripe_account_id, stripe_account_ready, payout_token, access_status (waitlist | active), invites_remaining
- `groups` — id, provider_group_id, name, organizer_user_id, added_by_user_id, created_by_nod (bool), spend_rules (json), joined_at, timezone
- `group_members` — group_id, user_id, opted_out
- `messages` — group_id, sender_user_id, text, media_urls, reactions (json), created_at
- `group_notes` — group_id, subject_user_id (nullable), note (e.g. "vegetarian"), created_at
- `pending_questions` — group_id, asked_user_id, nod_provider_message_id, question, remaining, expires_at (follow-up answers)
- `options` — group_id, kind (rental | restaurant | activity | event | ticket | other), source (link | search), url (normalized, unique per group), parsed (json), posted_by_user_id, provider_message_id
- `searches` — group_id, requested_by, query, location, starts_at / ends_at (the time asked about), results (json), created_at
- `bookings` — group_id, option_id, decision_id, requested_by_user_id, party_size, starts_at, ends_at, all_day, link, method (link | partner), status (proposed | confirming | link_sent | booked | cancelled | declined | expired | failed), booked_by_user_id, confirmation (json: code, depositCents, depositCurrency, depositPaidByUserId, notes, cancelFeeCents), partner, partner_booking_id, holder_user_id, proposal (json: the exact terms shown and who must approve), proposal_message_id, free_cancel_until, reminder_sent_at
- `booking_approvals` — booking_id, user_id (one per person per proposed booking)
- `decisions` — group_id, kind, question, status (open | runoff | decided | funded | booked | cancelled), round (1, or 2 for a runoff), parent_decision_id, created_by_user_id, winning_option_id, deadline_at, tie_break_user_id, nudge_sent_at
- `decision_options` — decision_id, option_id, position (the number people reply with)
- `date_poll_choices` — decision_id, position, starts_on, ends_on, chosen, message_id (Nod's message for that date; for decisions of kind `date_poll`)
- `date_poll_responses` — decision_id, user_id, positions (every choice that works for them)
- `votes` — decision_id, user_id, option_id, value (one per person per decision; a new vote replaces the old)
- `payment_collections` — group_id, decision_id, payee_user_id, description, currency, status (setup | collecting | captured | cancelled | expired), deadline_at, approval (json), message_id, reminder_sent_at, purpose (request | settle_up)
- `payment_requests` — collection_id, user_id, amount_cents, token (the private pay link), stripe_payment_intent_id, attempt, status (pending | authorized | capturing | captured | cancelled | failed)
- `payment_approvals` — collection_id, user_id
- `ledger_entries` — group_id, payer_user_id, amount_cents, currency, description, kind (expense | settlement), source (manual | receipt | booking_deposit | settle_up | outside), source_id (unique per group and source), receipt_id, created_by_user_id, voided_at
- `ledger_shares` — entry_id, user_id, amount_cents (who an entry was for; sums to its amount)
- `receipts` — group_id, uploaded_by_user_id, image_url, parsed (json: merchant, currency, items, extras, total)
- `events` — group_id, booking_id, title, starts_at, ends_at, all_day, location, description (for .ics invites at /e/[id].ics)
- `invites` — code, issued_by_user_id, redeemed_by_user_id, source (manual | post_trip)
- `waitlist` — phone, joined_at, notified_at

## Claude tools (Phase 1)

- `parse_listing(url)` — title, photo, price, sleeps, bedrooms, cancellation policy (from link preview; ask the poster for missing fields)
- `search_web(query, location, when, party_size, preferences)` — for "find us fun things to do in Tulum on Saturday night", restaurants, bars, events and activities. Runs a separate Claude call with the server-side web search tool (`web_search_20260209`, `max_uses` 5, `user_location` from the place asked about) that sees only these fields, never the chat. Saves the search and stores the picks as `options` (source: search) so the group can vote on and book them.
- `booking_link(option_id, party_size, starts_at_local | check_in + check_out)` — a reservation or booking link with party size and time filled in where the venue's platform supports it (OpenTable, Resy, Tock, Google Reserve, the venue's own page), else the venue's phone number
- `mark_booked(booking_id | option_id, confirmation_code, deposit_cents, paid_by, ...)` — records a booking someone completed, attaches the calendar invite, saves any deposit for the tab / `cancel_booking(booking_id, confirm_fee)`
- `propose_booking(option_id, party_size, starts_at_local)` / `check_availability(...)` / `approve_booking(booking_id?)` / `decline_booking(booking_id?)` — booking directly through a partner (step 9); offered only when a partner is configured
- `start_vote(option_ids, question, deadline_local | hours)` / `cast_vote(choice)` / `close_vote()` / `cancel_vote()` (counting is automatic; see step 7 in Progress)
- `run_date_poll(question, choices, deadline)` / `answer_date_poll(mode, positions)` / `close_date_poll()` / `cancel_date_poll()`
- `request_payments(description, amount_per_person_cents | total_cents, payers, deadline)` / `approve_payments` / `cancel_payments` / `resend_pay_link` — collects money for the caller: private pay links, holds, capture once fully funded
- `record_expense(description, amount, paid_by, split_with | shares | receipt_id + items | booking_id)` / `split_receipt(image)` / `undo_expense` / `record_payment(from, amount)` / `send_balances` / `settle_up`
- `create_calendar_event(...)` — generates and sends an `.ics` file
- `remember_group_note(...)` / `forget_group(group_id)`
- `delivery_link(service, items, address)` — deep link, not a real order yet

## Phase 1 scope

Build in this order, one per session, each with tests:
1. Local chat simulator (terminal or simple web page with multiple fake users; must support an existing group with prior history adding Nod mid-conversation, and mixed iPhone/Android groups) + `MessagingProvider` adapter
2. Inbound webhook, message storage, and `isAddressedToNod` detection (see "Calling Nod")
3. Group join handling: detect being added, introduction message, contact card, `added_by` tracking; personal setup flow (contact card, how-to video, privacy note); "start a group" fallback
4. Claude orchestration with context building and the tool framework
5. Rental link cards
6. Web search: "find us fun things to do in Tulum on Saturday night" (see "Web search and booking")
7. Voting, runoff, deadline decisions (Inngest), for both posted links and search results
8. Booking handoff: after the group picks, a booking link with the details filled in, "@Nod we booked it" to record it, and the calendar invite
9. Booking directly: Nod books through booking partners itself after the group approves the exact terms (see "Web search and booking")
10. Stripe authorize-then-capture flow and private pay links
11. Running tab, receipt split, settle-up
12. Date polling
13. Calendar invites (.ics)
14. Spending rules
15. Group notes and "forget this chat"
16. Invite system: text-based waitlist, codes, post-trip codes, `/join` page

## Web search and booking

**Searching (Phase 1, step 6).** When someone asks Nod to find something ("find us fun things to do in Tulum on Saturday night", "good tacos near the rental", "anything on at the beach club Friday?"), Nod searches the web with Claude's web search tool and answers in one message:
- The top 3–5 picks, one line each: name, what it is, when it's on or open, a price hint, and a short link. The full list goes on a web page (`/s/[searchId]`, an unguessable id), linked at the end.
- "Saturday night" and similar are read against today's date and the trip's dates and location when Nod knows them. If the place or day is unclear, Nod asks one short question instead of guessing.
- Picks are saved as options, so "@Nod let's vote on these" (step 7) works on search results just like posted rental links.
- Nod searches only when asked. It never searches on its own because of something said in the chat (rule 1).
- Only the request and what's needed to run it (place, dates, party size, group notes like "vegetarian") go into the search, never the chat transcript.
- Every pick comes from a source Nod actually found in this search. No invented venues, hours or prices; when a detail isn't confirmed, Nod says so.

**Booking hand-off (Phase 1, step 8; the fallback).** For venues Nod can't book itself, and for every rental (Airbnb has no booking API), once the group picks something ("@Nod book Hartwood for 6 at 8pm Saturday"), Nod replies with a booking link that has the party size and time filled in where the platform allows, or the venue's phone number. Whoever books it replies "@Nod we booked it" (or forwards the confirmation), and Nod marks it booked, sends the calendar invite and, if there was a deposit, offers to add it to the tab. Nod never says something is booked until someone confirms it.

**Booking directly (Phase 1, step 9).** Nod makes the reservation itself inside the chat wherever a booking partner covers the venue: restaurants first (OpenTable, Resy, SevenRooms, Tock, or an aggregator), then experiences and tickets (Viator, GetYourGuide). Each partner is an adapter behind `BookingPartner`, and each needs its own approved API access, so production has no partners until those applications come through; the flow runs against a labelled sample partner in the simulators and tests. Rules:
- Nod posts the exact venue, time, party size, deposit and cancellation policy before booking, and books only once the group approves under its spending rules (rule 4). Approval is a reply to Nod from someone it asked, "@Nod yes", or a 👍/❤️ tapback on the proposal. A plain "yes" from anyone else never counts.
- Deposits, prepayments and card holds are charged by the venue or platform directly. Nod never holds the money (rule 5).
- Nod re-checks the time and terms right before booking. If they changed, it shows the new terms and asks again.
- Cancellation windows and fees are shown before booking, and the person it's booked under gets a private reminder before free cancellation closes. A cancellation fee needs that person's (or the approver's) explicit OK.

**Simulator.** The web simulator can't reach the internet, so it uses a stand-in search that returns sample results marked as samples, which is enough to exercise the flow. Real searches run in production and in the terminal simulator with an API key.

### Progress

- **Step 1 done.** `src/messaging/types.ts` (the `MessagingProvider` interface and normalized events), `src/messaging/simulator/` (in-memory world, `SimulatorProvider`, seeded scenarios, `npm run sim` REPL), `src/messaging/sendblue/` (outbound only), `src/lib/http.ts` (timeout and retry wrapper).
- Simulator fidelity: Nod never receives pre-join messages. People can add Nod only to all-iPhone groups of 3+. Any Android member makes the group SMS, which means no tapbacks (they arrive as text like `Liked “…”`), no inline replies, and no mentions. Nod-created groups can be mixed.
- Step 2 must handle: the SMS tapback text (not a call, and should count as a vote), and replies or tapbacks that point at messages Nod never saw.
- **Step 2 done.** `src/detection/addressed.ts` (`isAddressedToNod`: a sync first pass sorts messages into certain, ambiguous or none; only ambiguous ones call `src/detection/classifier.ts`, which fails closed). `src/db/` (Drizzle schema for users, groups, group_members, messages; `MessageStore`; migrations in `drizzle/`; tests use in-process PGlite). `src/inbound/` (pipeline, `RecordingProvider` for Nod's own sends, `/api/inbound` handler). Next.js app in `src/app/`. The simulator CLI runs the real pipeline, and the web page shows each decision.
- Detection decisions beyond the original spec: "nod off"/"nod along" right after a trigger position are ambiguous, not certain. "nod" inside links and emails is ignored. SMS tapback text (`Liked “@Nod …”`) is never a call, even in a private thread. Counting it as a vote is left for step 7 (voting).
- Storage decisions: opted-out members' messages are stored with no text (the row still dedupes webhook retries), unless they call Nod. Retention runs on every insert. Reactions are stored as one tapback per person per message. The classifier sees the last 5 messages, with names only (never phone numbers).
- The classifier defaults to `claude-opus-5-5` at low effort with server-side refusal fallbacks. Set `NOD_CLASSIFIER_MODEL` for a cheaper model (e.g. `claude-haiku-4-5`).
- Step 3 hooks: the pipeline returns `nodAdded`/`addedByPhone` for join events and `firstSeenGroup` for groups first seen through a message. `onAddressed` is where step 4 plugs in; for now it only logs.
- **Step 3 done.** `src/onboarding/` (introduction, access note, can't-work-here offer, personal setup, card resend, "start a group"), `src/nod.ts` (`createNod` composes pipeline + onboarding; production, the CLI and the web page all use it). `Store` interface with `DrizzleStore` and `MemoryStore`, sharing one contract test suite; the web simulator runs the real app on `MemoryStore`. New columns: `users.setup_sent_at`, `groups.intro_sent_at` / `unsupported_at`; new table `user_contacts` (contact cards people shared). `/nod.vcf` serves Nod's contact card for Sendblue to attach.
- Onboarding decisions: the intro is claimed atomically (exactly once per join) and reset when Nod is removed, so a re-add gets a new intro. The intro opens "Will added me." when the adder's name is known, else "Hi, I'm Nod." Personal setup runs on the first private message from someone with access; step 16 (invites) should call `onboarding.personalSetup` on invite redemption. "Start a group" is private-only, needs access, takes names (matched against shared contact cards, then named people sharing a chat with the requester) or phone numbers, and allows 1–24 others. A bare "start a group" uses the group from a can't-work-here offer made in the last 7 days. Card requests are only acted on when addressed to Nod.
- Assets still needed: the five-second how-to video (`NOD_HOWTO_VIDEO_URL`, default `/add-nod.mp4`) and Nod's logo (`NOD_LOGO_URL`, default `/nod-logo.png`). Neither exists yet.
- Migrations: `drizzle/0000_init.sql` was regenerated in place for steps 2–3 because nothing is deployed. Once a database exists, add new migrations instead (`npm run db:generate`).
- **Step 4 done.** `src/agent/`: `context.ts` (system prompt + per-call context: date, chat, members, recent messages since Nod joined, pluggable `ContextSection`s for notes/decisions/tab, the new message), `tools.ts` (tool framework: `defineTool`, registry with local input validation, strict definitions, errors returned to Claude as `is_error` results; throw `ToolError` for a message Claude should see), `responder.ts` (manual agent loop on the Messages API; append-only history; parallel tool results in one user turn; max 6 Claude calls; one reply of at most 700 characters; empty reply means stay silent; an apology on API failure; silence on refusal), `tools/private-message.ts` (rule 3). `sample-responder.ts` runs the same context, prompt and tools through an Artifact's `sample` capability, which is how the web simulator gets real Claude replies.
- Step 4 decisions: replies default to `claude-opus-5-5` at medium effort with server-side refusal fallbacks (`NOD_MODEL`, `NOD_EFFORT`). The system prompt is cached. Members appear by name or "Member ending 1234", never full numbers. In production the reply runs after the webhook returns (Next.js `after`, via the pipeline's `defer`); a failure there is logged, not retried. Moving this to Inngest (arriving in step 7) would add retries.
- Adding a tool (steps 5+): write it with `defineTool` in `src/agent/tools/`, add it to `defaultTools` in `src/agent/tools/index.ts`, and put permission checks inside `run` using `ctx.caller`, `ctx.chat` and `ctx.members`. Context a feature needs on every call (open decisions, the tab) goes in a `ContextSection`.
- **Step 5 done.** `src/rentals/`: `listing.ts` (reads Open Graph tags, schema.org JSON-LD, title and description into a `Listing`: title, photo, site, location, price in integer cents with currency and per-night/total, sleeps, bedrooms, beds, baths, rating, cancellation; URL clean-up; one-line card; missing fields), `rentals.ts` (quiet link capture, `rental_options` context section, `parse_listing` and `update_option` tools), `fetch.ts` (production fetcher), `samples.ts` (labelled sample pages for the web simulator). `src/lib/safe-fetch.ts` guards against SSRF: http(s) on ports 80/443 only, no credentials or internal hostnames, private/loopback/link-local IPs refused on every redirect and again at connect time (undici lookup hook), 6 s timeout, 1.5 MB cap. New table `options` (one per URL per group). Pipeline hook `onMessage` runs for every readable message before call handling. Tools can offer one image for the reply with `ctx.attach` (sent only if exactly one is offered).
- Step 5 decisions: rental links (Airbnb, Vrbo, Booking.com, Plum Guide and similar) are saved without Nod speaking, but pages are only fetched when someone asks Nod. Reads are reused for 24 hours, failed reads retried next time. Details people give ("it's $310 a night") are saved with `update_option` and marked as manual, so a later page read never overwrites them. When the page can't be read or lacks fields, Nod asks the poster by name to reply to its message. Our fetcher identifies itself as `NodLinkPreview/1.0`; some sites block unknown bots, in which case Nod falls back to asking the poster.
- **Step 6 done.** `src/search/`: `picks.ts` (pick shape, one-line card, validation), `claude-searcher.ts` (separate Claude call with the web search tool; continues after `pause_turn`; returns JSON picks), `search.ts` (`search_web` tool and `search_options` context section), `page.ts` + `src/app/s/[searchId]/route.ts` (full results page), `samples.ts` (labelled sample results for the web simulator). New table `searches`.
- Step 6 decisions: privacy is enforced by design, since the searcher only receives the tool's fields. Picks are kept only if their link is on a site that appeared in that search's actual results (drops invented or unverified places; booking links get the same check). Up to 8 picks; Nod posts the best 3–5. At most 10 searches per chat per hour. Searches run at low effort (`NOD_SEARCH_MODEL` overrides the model). A pick whose link is already an option reuses it. Private-chat searches are saved but create no options. `getStore()` in the container gives read-only pages the database without Sendblue.
- **Follow-up answers added after step 6** (see "Calling Nod"). `isAddressedToNod` has a `followup` tier (reasons `answer_to_nod`, `not_an_answer`, `answer_check_error`), checked only when the sender has an open question and the message isn't already a call; the answer check (`src/detection/answer-classifier.ts`) fails closed. Windows open after the reply is actually sent (10 minutes, 2 messages): for the caller automatically when the reply asks a question (`asksQuestion` in `src/agent/responder.ts`), or for another member via `src/agent/tools/expect-answer.ts`; `src/agent/tools/members.ts` resolves member names for tools. New table `pending_questions`. When a message is taken as an answer, Claude's context says which question it answers. The rental tool now uses this when it asks a poster for missing details.
- **Step 7 done.** `src/voting/`: `votes.ts` (parsing "2" / "#2" / "option 2" / "I vote 2" / "I vote Casa Azul", SMS tapback text, tally), `voting.ts` (tools, silent vote capture, tapback votes, nudges, deadlines, runoff, tie-break, `open_vote` / `open_votes` / `last_decision` context). `src/jobs/`: `scheduler.ts` (`Scheduler` interface, `MemoryScheduler`, `InngestScheduler`, `runVoteTimeline`), `client.ts` + `functions.ts` + `/api/inngest` (the `vote-timeline` function sleeps until the nudge and the deadline). `src/lib/time.ts` (local times in a chat's timezone). `src/options/cards.ts` (option names in votes). New tables `decisions`, `decision_options`, `votes`; `groups.timezone`. Pipeline hook `onReaction`. Claude's context shows the chat's local time.
- Step 7 decisions: one open vote per group, 2–6 options, default deadline 24 hours (at most 14 days), times read in the group's timezone (default `NOD_TIMEZONE`, America/New_York). Nod posts the vote message and the result itself (one message each) and counts votes silently: bare numbers and explicit "I vote …" replies, tapbacks (love, like, emphasize, laugh) on an option's original link message, SMS tapback text, and `cast_vote`. Removing a tapback removes that vote; dislike doesn't count. Anyone in the group can start, close or cancel a vote (rule 6). Non-voters get one private nudge 3 hours before the close when the vote runs at least 4 hours, and can reply privately with a number. A tie gets one runoff (half the original time, 1–12 hours); a tie in the runoff is broken by whoever started the vote; no votes closes it. Scheduled jobs re-check the vote before acting, so closing early or a runoff never produces a second result. Deferred: running general replies through Inngest with retries, until tools that send messages or search are safe to repeat.
- **Step 8 done.** `src/booking/`: `links.ts` (fills party size and time into OpenTable, Resy and Tock links, and stay dates and guests into Airbnb, Vrbo and Booking.com links; other links are returned unchanged and marked as not filled in), `booking.ts` (`booking_link`, `mark_booked`, `cancel_booking` tools and the `bookings` context section), `ics.ts` + `src/app/e/[file]/route.ts` (RFC 5545 invite at `/e/{eventId}.ics`). New tables `bookings` and `events`. Search picks now keep the venue's phone number when found. Nod's rules now say never to call something booked unless `mark_booked` recorded it.
- Step 8 decisions: booking links use the option's `bookingUrl` from a search when there is one, else its link. Restaurants and activities take a local start time (the invite runs 2 hours); rentals take check-in and check-out dates (an all-day invite ending on the check-out date). `mark_booked` is only for bookings a person confirms; it also works for something booked without Nod's link. It marks the winning decision `booked`, and `cancel_booking` puts it back to `decided`. The invite is attached to Nod's one confirmation message (via `ctx.attach`). Deposits are saved on the booking with who paid, for step 11's tab to pick up. Step 13 still owns standalone `create_calendar_event`, updates and reminders.
- **Step 9 done.** `src/booking/`: `partners.ts` (`BookingPartner` interface: `venueFor`, `availability`, `book` with an idempotency key, `cancel`; `SlotUnavailableError`; `partnerFor`, which never matches rentals), `approvals.ts` (spending rules: `readSpendRules`, `approvalRequirement`, `isApproved`), `proposals.ts` (`check_availability`, `propose_booking`, `approve_booking`, `decline_booking`; tapback approvals; booking once approved; the private reminder; partner cancellation), `sample-partner.ts` (made-up times, deposits and `SAMPLE-` codes for the simulators and tests), `shared.ts`. New table `booking_approvals`; new booking columns and statuses (see Data model). The scheduler gained `scheduleBookingReminder` and the Inngest function `booking-reminder`; `nod.runJob` runs every kind of scheduled job. The web simulator trims Claude's tools to what the `sample` capability allows (`fitTools`), dropping the least-needed first.
- Step 9 decisions:
  - Who approves: groups don't name an organizer yet, so "the organizer" is whoever added Nod, then the requester. Nothing charged: any one member. Over $200 per person: three distinct members (or every member, in smaller groups). Step 14 lets groups change these rules (`groups.spend_rules`: approver, perPersonLimitCents, approvalsOverLimit).
  - Nod posts the proposal and the outcome itself, as one line each (so SMS tapback text can quote it), and follow-up windows open for the requester and a named approver.
  - One open proposal per group; a new one replaces it. Proposals go stale after 24 hours.
  - The status is claimed atomically before booking (`transitionBooking`), and the booking id is the partner idempotency key, so concurrent approvals or a retry never double-book. A failed booking keeps its approvals, and "@Nod try again" retries it.
  - Bookings go under the requester's name and phone, which is shared with the partner. A partner that needs the guest to pay the deposit returns a pay link, which Nod sends to that person privately.
  - The reminder goes out 3 hours before free cancellation ends, only when a fee applies after it.
  - Without partners (production today), the partner tools aren't offered to Claude, so every booking is a hand-off.
- **Step 10 done.** `src/payments/`: `gateway.ts` (`PaymentGateway` interface, `CardError`), `stripe-gateway.ts` (Stripe SDK 22, API version 2026-08-26.dahlia: Connect accounts, onboarding links, manual-capture PaymentIntents as direct charges on the payee's account, capture, cancel, webhook signature check), `fake-gateway.ts` (tests and simulators), `split.ts` (shares in whole cents, $1 minimum, $5,000 cap per person), `payments.ts` (tools, pay links, holds, capture, reminders, deadlines, payout setup, tapback approvals, `payments` context section), `page.ts` (pay page with Stripe's Payment Element; payout result page), `webhook.ts`. Routes: `/pay/[token]` (GET page, POST creates or reuses the hold), `/connect/[token]` (payout setup and return), `/api/stripe` (Connect webhook). The scheduler gained `scheduleCollection` and the Inngest function `collection-timeline`. The web simulator has sample "Pay" and "Set up payouts" buttons on Nod's private links and a skip-to-payment-deadline button; the terminal simulator has `/pay` and `/payouts`.
- Step 10 decisions:
  - Money goes only to the person who asks Nod to collect it (the payee), straight to their own Stripe account. The first time, Nod privately sends them a payout setup link; pay links go out once Stripe says the account can take payments.
  - Amounts: per person, or a total split evenly (the requester shares by default and absorbs leftover cents). Payers default to everyone else in the group. Default deadline 48 hours, at most 6 days, since card holds last about a week.
  - Rule 4: the group sees the amount in Nod's request message before anyone pays, and nothing is captured until everyone has paid and the spending rules are met. Paying your share counts as approving it, as does the payee's own request; otherwise approval is a tapback on the request or "@Nod yes" (`approve_payments`).
  - Rule 3: pay links, reminders (24 hours before the deadline), declined-card notes and who hasn't paid go to people privately. The group hears the request, counts and the outcome, and Claude's group context says not to name who hasn't paid.
  - Every card is charged in one pass once fully funded; each request is claimed atomically and each capture has an idempotency key. A declined capture asks that person privately to pay again; an unknown error puts the request back to retry. A hold that lapses (canceled on Stripe) is replaced with a fresh one and the payer is asked again.
  - At the deadline without full funding, every uncharged hold is released and the payee privately gets the names of who didn't pay. A hold made after a collection closed is released at once.
  - Webhook events only trigger a re-read from Stripe; the pay page also re-reads the hold when someone comes back from Stripe, so it works before the webhook arrives.
  - Payments are on in production only when `STRIPE_SECRET_KEY` is set; without a gateway the payment tools aren't offered.
- **Step 11 done.** `src/tab/`: `math.ts` (even, exact and receipt splits that always add up to the cent, balances, settle-up transfers), `receipts.ts` (`ReceiptReader`, `cleanReceipt`, labelled sample receipt), `claude-receipts.ts` (Claude reads the photo from its URL and returns JSON items and total; it sees only the image), `tab.ts` (the tools above, the `tab` context section, and settle-up payments landing on the tab). New tables `ledger_entries`, `ledger_shares`, `receipts`; `payment_collections.purpose`; store `groupsForUser` and `recentMedia`. Tools can see the current message's attachments (`ctx.mediaUrls`). `payments.startCollection` opens a collection for any payee (used by settle-up), and payments calls `onRequestCaptured` after each charge. The web simulator has an "Attach a sample receipt photo" chip; the terminal simulator has `/photo`.
- Step 11 decisions:
  - The tab is entries (who paid, how much) with shares (who it was for). A balance is paid minus shares; paying someone back is an entry too, so nothing is ever edited in place. Wrong entries are voided by whoever added or paid them.
  - Splits: even (default everyone; leftover cents go to the first people), exact amounts (must add up), or by receipt: assigned items go to their people, unassigned items are shared, and tax, tip and fees follow what each person had. Rounding uses largest remainders, so every split adds up exactly.
  - A booking's deposit goes on the tab once, when someone says so (`mark_booked` now suggests it); its source id stops it being added twice.
  - Receipts: the photo on the message Nod is answering, else the latest photo in the group from the last 30 minutes. Nod lists the numbered items and asks whether to split evenly or who had what.
  - Rule 3: expense confirmations in the group never list what each person owes. "What's the tab?" texts each person their own balance and who they'd pay (`send_balances`). The group context carries totals and entries, not balances.
  - Settle-up: the biggest debtor pays the biggest creditor until everyone is even (at most one payment fewer than the number of people; payments under $1 are skipped). With payments set up, each creditor gets a settle-up collection (pay links, holds, capture once all of that creditor's payers are in); paying is the approval, since each person only pays their own debt. Each charge is recorded on the tab as it happens. Without payments, everyone involved is told privately who to pay, and the person paid records it (`record_payment`). One settle-up at a time.
  - Collections made with `request_payments` stay off the tab: they're for something already paid outside it, and recording both sides would net to zero anyway.
- **Step 12 done.** `src/dates/`: `availability.ts` (reading "1 3", "1 and 3", "only 2", "also 3", "can't do 2", "all", "none"; applying answers; picking the dates that work for the most people; compact date ranges like "Mar 14–18"), `polls.ts` (the tools above, silent answer capture, early close, nudges, results, `open_date_poll` / `chosen_dates` / `open_date_polls` context). New tables `date_poll_choices`, `date_poll_responses`; store `transitionDecision` (a result is posted once). Votes now ignore open date polls.
- Step 12 decisions:
  - A date poll is a decision of kind `date_poll`, so a group has one open vote or poll at a time, and polls reuse the vote nudge and deadline jobs (`nod.runJob` routes by the decision's kind).
  - 2–6 choices, each a local date or date range, none in the past. Default deadline 48 hours, at most 14 days.
  - Changed after step 12 at the user's request: people pick dates by tapping, not by typing numbers. Nod posts a short header and then one message per date (a deliberate exception to "one message per action"), and people tap 👍 or ❤️ on every date that works; removing the tapback or tapping 👎 takes it back, and laugh or question tapbacks are ignored. SMS tapback text (`Liked “Mar 14–18”`) counts the same way. Typed replies ("1 3", "all", "none", "also 3", "can't do 2") still count silently as a fallback; as a first answer, "can't do 2" means every other choice works. Private replies to the nudge go through `answer_date_poll`.
  - The poll closes at the deadline, or 10 minutes after everyone in the group has answered (time to finish tapping; the deadline is brought forward and rescheduled). The winner is the choice that works for the most people, with ties going to the earlier dates. The result names who can't make it and who didn't answer (availability, not money, so it's fine in the group). If nothing works for anyone, or nobody answered, the poll closes without dates.
  - Afterwards Claude's context carries the chosen dates, so later searches and bookings use them.
- To verify with Sendblue before launch: tap-to-vote needs Sendblue's reaction (tapback) webhooks, which aren't parsed yet (see the Sendblue note below). Also ask whether Sendblue can send and read iOS 26's native Messages polls; if it can, date polls could use them, with the per-date messages kept for SMS groups.
- To verify before launch: that Sendblue's media URLs can be fetched by Anthropic's servers for receipt reading (if they need auth, download the image and send it base64 instead).
- To verify against Stripe's docs before launch: the Connect account settings in `createAccount` (controller fees, losses and dashboard for direct charges; docs.stripe.com was blocked here, so these come from the SDK's types), how long card holds last for the card networks you'll see, and the webhook endpoint setup ("events on connected accounts").
- To verify against each platform's docs: the booking link parameters (OpenTable `covers`/`dateTime`, Resy `date`/`seats`, Tock `/search?date&size&time`, Airbnb `check_in`/`check_out`/`adults`, Vrbo `startDate`/`endDate`/`adults`, Booking.com `checkin`/`checkout`/`group_adults`). They come from public URLs, not official documentation.
- Plan change after step 4: added web search (new step 6) and a booking hand-off (new step 8), which renumbers the later steps. The responder already handles `pause_turn`, which long server-side searches can return.
- Plan change after step 8: booking directly moved from Phase 2 into Phase 1 as step 9 (payments are now step 10, and the later steps move down one).
- To verify against Sendblue's docs: the webhook fields (reactions, inline replies, mentions and group join events are not parsed yet), plus the response fields (`message_handle`, `service`), group naming and photo (not set on Nod-created groups yet), inline replies, native contact cards, and whether shared vCards arrive as `.vcf` media links. Sends are not retried on timeout, to avoid duplicate messages.

## Not yet (don't build unless asked)

Real booking-partner adapters (each waits on that partner's API approval), voice calls, real delivery orders, ticket purchases, WhatsApp, points maximizing, year-end recap.

## Working conventions

- Write tests first for anything touching money, votes, or permissions.
- Never log full card data, payment tokens, or message contents at info level.
- All money in integer cents.
- Every external call (Sendblue, Stripe, Claude) goes through a wrapper with retries and timeouts.
- Secrets in environment variables only; keep `.env.example` up to date.
- After each feature: run tests, update this file if the plan changed, and summarize what was built in plain English.
