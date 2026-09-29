# CLAUDE.md — Nod group-chat agent

Read this file before every session. It defines what we're building, the rules the product must follow, and how to work in this repo.

## What we're building

An AI agent that people add to an iMessage group chat (WhatsApp later). It stays silent unless someone calls it. When called, it helps the group decide and pay for things: rentals, restaurants, deliveries, tickets. It keeps a running tab of who owes what.

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

Nod is a real English word, so detection has two tiers.

**Certain triggers (always respond):**
- `@Nod` anywhere in the message (case-insensitive), including iMessage mentions of Nod's contact
- `Nod` as the first word of a message, optionally followed by punctuation ("Nod, book the 8pm", "Nod book it")
- A greeting directly before the name anywhere in the message: "hey Nod", "yo Nod", "hi Nod", "ok Nod"
- An inline reply to one of Nod's own messages
- Any private (1:1) message to Nod

**Ambiguous (check before responding):**
- "nod" appears anywhere else in the message ("he gave me the nod", "I'll nod along")
- Run a fast, cheap classification call to Claude: "Is this message addressed to the assistant named Nod? Answer yes or no." Respond only on a clear yes.

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
Web page: /pay/[token], /group/[id]/settings, /join (invite code entry)
```

Keep messaging behind an adapter interface (`MessagingProvider`) with implementations for Sendblue and a local simulator. WhatsApp will be added later without touching business logic.

## Data model (starting point)

- `users` — phone, name, stripe_customer_id, access_status (waitlist | active), invites_remaining
- `groups` — id, provider_group_id, name, organizer_user_id, added_by_user_id, created_by_nod (bool), spend_rules (json), joined_at
- `group_members` — group_id, user_id, opted_out
- `messages` — group_id, sender_user_id, text, media_urls, reactions (json), created_at
- `group_notes` — group_id, subject_user_id (nullable), note (e.g. "vegetarian"), created_at
- `options` — group_id, kind (rental | restaurant | ticket | other), url, parsed (json), posted_by, message_id
- `votes` — option_id, user_id, value
- `decisions` — group_id, kind, status (open | decided | funded | booked | cancelled), winning_option_id, deadline_at
- `payment_requests` — decision_id, user_id, amount_cents, stripe_payment_intent_id, status
- `ledger_entries` — group_id, payer_user_id, amount_cents, description, split (json), settled
- `events` — group_id, title, starts_at, ends_at, location (for .ics invites)
- `invites` — code, issued_by_user_id, redeemed_by_user_id, source (manual | post_trip)
- `waitlist` — phone, joined_at, notified_at

## Claude tools (Phase 1)

- `parse_listing(url)` — title, photo, price, sleeps, bedrooms, cancellation policy (from link preview; ask the poster for missing fields)
- `start_vote(option_ids, deadline)` / `tally_votes(decision_id)`
- `run_date_poll(candidate_dates)`
- `request_payments(decision_id, amount_per_person)` — creates PaymentIntents and sends private pay links
- `record_expense(payer, amount, description, split)` / `split_receipt(image)` / `settle_up(group_id)`
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
6. Voting, runoff, deadline decisions (Inngest)
7. Stripe authorize-then-capture flow and private pay links
8. Running tab, receipt split, settle-up
9. Date polling
10. Calendar invites (.ics)
11. Spending rules
12. Group notes and "forget this chat"
13. Invite system: text-based waitlist, codes, post-trip codes, `/join` page

### Progress

- **Step 1 done.** `src/messaging/types.ts` (the `MessagingProvider` interface and normalized events), `src/messaging/simulator/` (in-memory world, `SimulatorProvider`, seeded scenarios, `npm run sim` REPL), `src/messaging/sendblue/` (outbound only), `src/lib/http.ts` (timeout and retry wrapper).
- Simulator fidelity: Nod never receives pre-join messages. People can add Nod only to all-iPhone groups of 3+. Any Android member makes the group SMS, which means no tapbacks (they arrive as text like `Liked “…”`), no inline replies, and no mentions. Nod-created groups can be mixed.
- Step 2 must handle: the SMS tapback text (not a call, and should count as a vote), and replies or tapbacks that point at messages Nod never saw.
- To verify against Sendblue's docs: the response fields (`message_handle`, `service`), group naming and photo, inline replies, and native contact cards. Sends are not retried on timeout, to avoid duplicate messages.

## Not yet (don't build unless asked)

Real restaurant booking, voice calls, real delivery orders, tickets, WhatsApp, points maximizing, year-end recap.

## Working conventions

- Write tests first for anything touching money, votes, or permissions.
- Never log full card data, payment tokens, or message contents at info level.
- All money in integer cents.
- Every external call (Sendblue, Stripe, Claude) goes through a wrapper with retries and timeouts.
- Secrets in environment variables only; keep `.env.example` up to date.
- After each feature: run tests, update this file if the plan changed, and summarize what was built in plain English.
