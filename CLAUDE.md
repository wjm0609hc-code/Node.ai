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
- **Step 2 done.** `src/detection/addressed.ts` (`isAddressedToNod`: a sync first pass sorts messages into certain, ambiguous or none; only ambiguous ones call `src/detection/classifier.ts`, which fails closed). `src/db/` (Drizzle schema for users, groups, group_members, messages; `MessageStore`; migrations in `drizzle/`; tests use in-process PGlite). `src/inbound/` (pipeline, `RecordingProvider` for Nod's own sends, `/api/inbound` handler). Next.js app in `src/app/`. The simulator CLI runs the real pipeline, and the web page shows each decision.
- Detection decisions beyond the original spec: "nod off"/"nod along" right after a trigger position are ambiguous, not certain. "nod" inside links and emails is ignored. SMS tapback text (`Liked “@Nod …”`) is never a call, even in a private thread. Counting it as a vote is left for step 6.
- Storage decisions: opted-out members' messages are stored with no text (the row still dedupes webhook retries), unless they call Nod. Retention runs on every insert. Reactions are stored as one tapback per person per message. The classifier sees the last 5 messages, with names only (never phone numbers).
- The classifier defaults to `claude-opus-5-5` at low effort with server-side refusal fallbacks. Set `NOD_CLASSIFIER_MODEL` for a cheaper model (e.g. `claude-haiku-4-5`).
- Step 3 hooks: the pipeline returns `nodAdded`/`addedByPhone` for join events and `firstSeenGroup` for groups first seen through a message. `onAddressed` is where step 4 plugs in; for now it only logs.
- **Step 3 done.** `src/onboarding/` (introduction, access note, can't-work-here offer, personal setup, card resend, "start a group"), `src/nod.ts` (`createNod` composes pipeline + onboarding; production, the CLI and the web page all use it). `Store` interface with `DrizzleStore` and `MemoryStore`, sharing one contract test suite; the web simulator runs the real app on `MemoryStore`. New columns: `users.setup_sent_at`, `groups.intro_sent_at` / `unsupported_at`; new table `user_contacts` (contact cards people shared). `/nod.vcf` serves Nod's contact card for Sendblue to attach.
- Onboarding decisions: the intro is claimed atomically (exactly once per join) and reset when Nod is removed, so a re-add gets a new intro. The intro opens "Will added me." when the adder's name is known, else "Hi, I'm Nod." Personal setup runs on the first private message from someone with access; step 13 should call `onboarding.personalSetup` on invite redemption. "Start a group" is private-only, needs access, takes names (matched against shared contact cards, then named people sharing a chat with the requester) or phone numbers, and allows 1–24 others. A bare "start a group" uses the group from a can't-work-here offer made in the last 7 days. Card requests are only acted on when addressed to Nod.
- Assets still needed: the five-second how-to video (`NOD_HOWTO_VIDEO_URL`, default `/add-nod.mp4`) and Nod's logo (`NOD_LOGO_URL`, default `/nod-logo.png`). Neither exists yet.
- Migrations: `drizzle/0000_init.sql` was regenerated in place for steps 2–3 because nothing is deployed. Once a database exists, add new migrations instead (`npm run db:generate`).
- **Step 4 done.** `src/agent/`: `context.ts` (system prompt + per-call context: date, chat, members, recent messages since Nod joined, pluggable `ContextSection`s for notes/decisions/tab, the new message), `tools.ts` (tool framework: `defineTool`, registry with local input validation, strict definitions, errors returned to Claude as `is_error` results; throw `ToolError` for a message Claude should see), `responder.ts` (manual agent loop on the Messages API; append-only history; parallel tool results in one user turn; max 6 Claude calls; one reply of at most 700 characters; empty reply means stay silent; an apology on API failure; silence on refusal), `tools/private-message.ts` (rule 3). `sample-responder.ts` runs the same context, prompt and tools through an Artifact's `sample` capability, which is how the web simulator gets real Claude replies.
- Step 4 decisions: replies default to `claude-opus-5-5` at medium effort with server-side refusal fallbacks (`NOD_MODEL`, `NOD_EFFORT`). The system prompt is cached. Members appear by name or "Member ending 1234", never full numbers. In production the reply runs after the webhook returns (Next.js `after`, via the pipeline's `defer`); a failure there is logged, not retried. Moving this to Inngest is a later option.
- Adding a tool (steps 5+): write it with `defineTool` in `src/agent/tools/`, add it to `defaultTools` in `src/agent/tools/index.ts`, and put permission checks inside `run` using `ctx.caller`, `ctx.chat` and `ctx.members`. Context a feature needs on every call (open decisions, the tab) goes in a `ContextSection`.
- To verify against Sendblue's docs: the webhook fields (reactions, inline replies, mentions and group join events are not parsed yet), plus the response fields (`message_handle`, `service`), group naming and photo (not set on Nod-created groups yet), inline replies, native contact cards, and whether shared vCards arrive as `.vcf` media links. Sends are not retried on timeout, to avoid duplicate messages.

## Not yet (don't build unless asked)

Real restaurant booking, voice calls, real delivery orders, tickets, WhatsApp, points maximizing, year-end recap.

## Working conventions

- Write tests first for anything touching money, votes, or permissions.
- Never log full card data, payment tokens, or message contents at info level.
- All money in integer cents.
- Every external call (Sendblue, Stripe, Claude) goes through a wrapper with retries and timeouts.
- Secrets in environment variables only; keep `.env.example` up to date.
- After each feature: run tests, update this file if the plan changed, and summarize what was built in plain English.
