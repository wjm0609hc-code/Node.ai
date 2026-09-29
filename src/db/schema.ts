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

export type User = typeof users.$inferSelect;
export type Search = typeof searches.$inferSelect;
export type Option = typeof options.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type Message = typeof messages.$inferSelect;
