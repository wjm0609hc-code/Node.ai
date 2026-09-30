// Database schema (Drizzle). Starting point from CLAUDE.md "Data model";
// tables for later steps are added as those steps land.

import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const accessStatus = pgEnum("access_status", ["waitlist", "active"]);
export const service = pgEnum("service", ["imessage", "sms"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull().unique(),
  name: text("name"),
  stripeCustomerId: text("stripe_customer_id"),
  /** Stripe Connect account that receives money this person collects (rule 5: straight to them, never through Nod). */
  stripeAccountId: text("stripe_account_id"),
  /** True once Stripe says the account can take card payments. */
  stripeAccountReady: boolean("stripe_account_ready").notNull().default(false),
  /** Unguessable token for this person's payout setup link (/connect/[token]). */
  payoutToken: text("payout_token").unique(),
  accessStatus: accessStatus("access_status").notNull().default("waitlist"),
  invitesRemaining: integer("invites_remaining").notNull().default(0),
  /** When Nod sent the private welcome, card, how-to video and privacy note. */
  setupSentAt: timestamp("setup_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerGroupId: text("provider_group_id").notNull(),
    name: text("name"),
    organizerUserId: uuid("organizer_user_id").references(() => users.id),
    addedByUserId: uuid("added_by_user_id").references(() => users.id),
    createdByNod: boolean("created_by_nod").notNull().default(false),
    spendRules: jsonb("spend_rules").notNull().default(sql`'{}'::jsonb`),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    /** Claimed when the introduction goes out; cleared when Nod is removed. */
    introSentAt: timestamp("intro_sent_at", { withTimezone: true }),
    /** Set when Nod was added somewhere it can't work (e.g. an SMS group). */
    unsupportedAt: timestamp("unsupported_at", { withTimezone: true }),
    /** IANA timezone for deadlines and times people mention; null means the app default (NOD_TIMEZONE). */
    timezone: text("timezone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("groups_provider_group_idx").on(t.provider, t.providerGroupId)],
);

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    optedOut: boolean("opted_out").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Insertion order; breaks ties between messages with the same timestamp. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    /** Set for group messages. */
    groupId: uuid("group_id").references(() => groups.id, { onDelete: "cascade" }),
    /** Set for private (1:1) messages: the person Nod is talking with. */
    dmUserId: uuid("dm_user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Null when Nod sent it. */
    senderUserId: uuid("sender_user_id").references(() => users.id, { onDelete: "set null" }),
    fromNod: boolean("from_nod").notNull().default(false),
    /** Null when the sender opted out and the message wasn't addressed to Nod. */
    text: text("text"),
    mediaUrls: jsonb("media_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    service: service("service").notNull(),
    replyToProviderMessageId: text("reply_to_provider_message_id"),
    /** userId -> tapback. One tapback per person, like iMessage. */
    reactions: jsonb("reactions").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    addressed: boolean("addressed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("messages_provider_message_idx").on(t.provider, t.providerMessageId),
    index("messages_group_created_idx").on(t.groupId, t.createdAt),
    index("messages_dm_created_idx").on(t.dmUserId, t.createdAt),
  ],
);

/** People a user shared with Nod as contact cards, for "start a group with Jake". */
export const userContacts = pgTable(
  "user_contacts",
  {
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerUserId, t.phone] })],
);

export const optionKind = pgEnum("option_kind", ["rental", "restaurant", "activity", "event", "ticket", "other"]);
export const optionSource = pgEnum("option_source", ["link", "search"]);

/** Things the group is choosing between: posted links (rentals now) and, from step 6, search results. */
export const options = pgTable(
  "options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    kind: optionKind("kind").notNull(),
    source: optionSource("source").notNull(),
    /** Normalized URL; one option per link per group. */
    url: text("url").notNull(),
    /** What Nod read from the page plus details people gave (see src/rentals/listing.ts). */
    parsed: jsonb("parsed").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    postedByUserId: uuid("posted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    providerMessageId: text("provider_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("options_group_url_idx").on(t.groupId, t.url)],
);

/** Web searches Nod ran ("find us fun things to do in Tulum on Saturday night"). */
export const searches = pgTable(
  "searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for a search in a private chat. */
    groupId: uuid("group_id").references(() => groups.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    query: text("query").notNull(),
    location: text("location"),
    whenText: text("when_text"),
    results: jsonb("results").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("searches_group_created_idx").on(t.groupId, t.createdAt)],
);

/** A question Nod asked one member in a group; their next message(s) may answer it without @Nod. */
export const pendingQuestions = pgTable(
  "pending_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    askedUserId: uuid("asked_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    nodProviderMessageId: text("nod_provider_message_id").notNull(),
    question: text("question").notNull(),
    /** Messages from the asked person still to be checked; 0 means closed. */
    remaining: integer("remaining").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("pending_questions_lookup_idx").on(t.groupId, t.askedUserId, t.createdAt)],
);

export const decisionStatus = pgEnum("decision_status", ["open", "runoff", "decided", "funded", "booked", "cancelled"]);

/** A group decision (step 7: votes; later funded and booked). */
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    question: text("question").notNull(),
    status: decisionStatus("status").notNull().default("open"),
    /** 1 for the vote, 2 for its runoff. */
    round: integer("round").notNull().default(1),
    parentDecisionId: uuid("parent_decision_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    winningOptionId: uuid("winning_option_id").references(() => options.id, { onDelete: "set null" }),
    /** Null while waiting for a tie-break. */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    /** Set when a runoff tied again: only this person's pick decides. */
    tieBreakUserId: uuid("tie_break_user_id").references(() => users.id, { onDelete: "set null" }),
    nudgeSentAt: timestamp("nudge_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("decisions_group_status_idx").on(t.groupId, t.status)],
);

export const decisionOptions = pgTable(
  "decision_options",
  {
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => decisions.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => options.id, { onDelete: "cascade" }),
    /** The number people reply with, from 1. */
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.decisionId, t.optionId] })],
);

/** One vote per person per decision; a new vote replaces the old one. */
export const votes = pgTable(
  "votes",
  {
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => decisions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => options.id, { onDelete: "cascade" }),
    value: integer("value").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.decisionId, t.userId] })],
);

/**
 * proposed: Nod posted exact terms and is waiting for approval. confirming: approved, booking with the partner now.
 * link_sent: a hand-off link. booked / cancelled. declined: the group called off a proposal. expired: a proposal went stale.
 * failed: the partner refused the booking.
 */
export const bookingStatus = pgEnum("booking_status", [
  "proposed",
  "confirming",
  "link_sent",
  "booked",
  "cancelled",
  "declined",
  "expired",
  "failed",
]);

/** The exact terms Nod showed the group before a partner booking (rule 4: the group sees the amount first). */
export interface ProposalTerms {
  slotId: string;
  /** Total deposit or prepayment the venue or platform charges; 0 for none. Integer cents. */
  depositCents: number;
  currency: string;
  /** Free cancellation until this ISO time; null if there is none. */
  freeCancelUntil: string | null;
  /** Fee for cancelling after the free window, in cents. */
  cancelFeeCents: number;
  policy: string;
  /** Who has to approve, worked out from the group's spending rules when proposed. */
  approval: { kind: "one_of"; userIds: string[] } | { kind: "count"; count: number };
}

/** A booking hand-off (step 8): the link Nod sent, then what someone actually booked. */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => options.id, { onDelete: "cascade" }),
    decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "set null" }),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    partySize: integer("party_size").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** Stays (check-in to check-out dates) rather than a time. */
    allDay: boolean("all_day").notNull().default(false),
    link: text("link"),
    /** "link" for a hand-off; "partner" when Nod books through a partner API itself. */
    method: text("method").notNull().default("link"),
    /** Partner booking: which partner (e.g. "opentable"), its booking id, and whose name it's under. */
    partner: text("partner"),
    partnerBookingId: text("partner_booking_id"),
    holderUserId: uuid("holder_user_id").references(() => users.id, { onDelete: "set null" }),
    proposal: jsonb("proposal").$type<ProposalTerms>(),
    /** Nod's proposal message, so tapbacks on it count as approvals. */
    proposalMessageId: text("proposal_message_id"),
    freeCancelUntil: timestamp("free_cancel_until", { withTimezone: true }),
    /** Claimed when the private "free cancellation ends soon" reminder goes out. */
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    status: bookingStatus("status").notNull().default("link_sent"),
    bookedByUserId: uuid("booked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** code, depositCents, depositCurrency, depositPaidByUserId, notes */
    confirmation: jsonb("confirmation").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("bookings_group_idx").on(t.groupId, t.createdAt)],
);

/** One approval per person per proposed booking. */
export const bookingApprovals = pgTable(
  "booking_approvals",
  {
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.userId] })],
);

/**
 * setup: waiting for the payee to finish payout setup. collecting: pay links are out; cards are held (authorized)
 * as people pay and captured only once everyone has paid and the spending rules are met. captured: done.
 * cancelled: called off. expired: the deadline passed before everyone paid, so holds were released.
 */
export const collectionStatus = pgEnum("collection_status", ["setup", "collecting", "captured", "cancelled", "expired"]);

/** One group payment: several people each paying their share to one person (the payee). */
export const paymentCollections = pgTable(
  "payment_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "set null" }),
    /** Who the money goes to; always the person who asked Nod to collect it. */
    payeeUserId: uuid("payee_user_id")
      .notNull()
      .references(() => users.id),
    description: text("description").notNull(),
    currency: text("currency").notNull().default("USD"),
    status: collectionStatus("status").notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    /** Who must approve the charge under the group's spending rules (see booking/approvals.ts). */
    approval: jsonb("approval").$type<ProposalTerms["approval"]>().notNull(),
    /** Nod's request message in the group, so tapbacks on it count as approvals. */
    messageId: text("message_id"),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("payment_collections_group_idx").on(t.groupId, t.createdAt)],
);

/**
 * pending: link sent, not paid. authorized: card held. capturing: being charged now. captured: charged.
 * cancelled: hold released or request called off. failed: the charge was declined (they get a new link).
 */
export const paymentRequestStatus = pgEnum("payment_request_status", ["pending", "authorized", "capturing", "captured", "cancelled", "failed"]);

/** One person's share of a collection, paid through their private /pay/[token] link. */
export const paymentRequests = pgTable(
  "payment_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => paymentCollections.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    amountCents: integer("amount_cents").notNull(),
    /** Unguessable; the pay link is the only way to pay, so never log it. */
    token: text("token").notNull().unique(),
    stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
    /** Bumped whenever a hold is replaced, so each new hold gets its own idempotency key. */
    attempt: integer("attempt").notNull().default(0),
    status: paymentRequestStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("payment_requests_person_idx").on(t.collectionId, t.userId)],
);

/** Explicit approvals of a collection's charge (paying your share also counts; see payments.ts). */
export const paymentApprovals = pgTable(
  "payment_approvals",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => paymentCollections.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.userId] })],
);

/** Calendar events, served as .ics invites at /e/[id].ics (the id is unguessable). */
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  allDay: boolean("all_day").notNull().default(false),
  location: text("location"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export type User = typeof users.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type CalendarEvent = typeof events.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type PendingQuestion = typeof pendingQuestions.$inferSelect;
export type Search = typeof searches.$inferSelect;
export type Option = typeof options.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type PaymentCollection = typeof paymentCollections.$inferSelect;
export type PaymentRequest = typeof paymentRequests.$inferSelect;
