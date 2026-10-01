// Persistence for users, groups, members and recent messages. Enforces the
// privacy rules from CLAUDE.md: keep at most the last 200 messages or 30 days
// per chat (whichever is smaller), and skip opted-out members' messages.

import { and, asc, desc, eq, gt, gte, inArray, lte, isNotNull, isNull, lt, not, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Phone, Service, Tapback } from "../messaging/types";
import type { RecentMessage } from "../detection/addressed";
import type { Db } from "./client";
import {
  groupMembers,
  groups,
  messages,
  options,
  pendingQuestions,
  searches,
  userContacts,
  users,
  decisions,
  decisionOptions,
  votes,
  bookingApprovals,
  bookings,
  events,
  datePollChoices,
  datePollResponses,
  groupNotes,
  type GroupNote,
  type DatePollChoice,
  ledgerEntries,
  ledgerShares,
  paymentApprovals,
  paymentCollections,
  paymentRequests,
  receipts,
  invites,
  waitlist,
  replies,
  type Reply,
  type Invite,
  type WaitlistEntry,
  type LedgerEntry,
  type ParsedReceipt,
  type Receipt,
  type PaymentCollection,
  type PaymentRequest,
  type ProposalTerms,
  type Booking,
  type CalendarEvent,
  type Decision,
  type Group,
  type Option,
  type PendingQuestion,
  type Search,
  type User,
} from "./schema";

export type { DatePollChoice, GroupNote, LedgerEntry, ParsedReceipt, PaymentCollection, PaymentRequest, ProposalTerms, Receipt } from "./schema";
export type { Booking, CalendarEvent, Decision, Group, Option, PendingQuestion, Search, User } from "./schema";
export type { Invite, Reply, WaitlistEntry } from "./schema";
export type ReplyPatch = Partial<Pick<Reply, "status" | "history" | "results" | "attachments" | "expectedFrom" | "replyText" | "sentMessageId">>;
export type InviteSource = "manual" | "member" | "post_trip";

export interface CreateBookingInput {
  groupId: string;
  optionId: string;
  decisionId: string | null;
  requestedByUserId: string | null;
  partySize: number;
  startsAt: Date | null;
  endsAt: Date | null;
  allDay: boolean;
  link: string | null;
  method: string;
  /** Defaults to link_sent. */
  status?: BookingStatus;
  partner?: string | null;
  holderUserId?: string | null;
  proposal?: ProposalTerms | null;
  freeCancelUntil?: Date | null;
}

export type BookingStatus = Booking["status"];

export type BookingPatch = Partial<
  Pick<
    Booking,
    | "status"
    | "bookedByUserId"
    | "confirmation"
    | "startsAt"
    | "endsAt"
    | "allDay"
    | "partySize"
    | "link"
    | "partnerBookingId"
    | "proposal"
    | "proposalMessageId"
    | "freeCancelUntil"
  >
>;

export interface CreateCollectionInput {
  groupId: string;
  decisionId: string | null;
  payeeUserId: string;
  description: string;
  currency: string;
  status: PaymentCollection["status"];
  deadlineAt: Date;
  approval: PaymentCollection["approval"];
  /** Defaults to "request". */
  purpose?: string;
  requests: Array<{ userId: string; amountCents: number; token: string }>;
}

export interface LedgerShare {
  userId: string;
  amountCents: number;
}

export type LedgerEntryWithShares = LedgerEntry & { shares: LedgerShare[] };

export interface CreateLedgerEntryInput {
  groupId: string;
  payerUserId: string;
  amountCents: number;
  currency: string;
  description: string;
  kind: "expense" | "settlement";
  source: string;
  sourceId: string | null;
  receiptId: string | null;
  createdByUserId: string | null;
  shares: LedgerShare[];
}

export type CollectionPatch = Partial<Pick<PaymentCollection, "status" | "messageId" | "deadlineAt">>;
export type PaymentRequestStatus = PaymentRequest["status"];
export type PaymentRequestPatch = Partial<Pick<PaymentRequest, "status" | "stripePaymentIntentId" | "attempt">>;

export interface CreateEventInput {
  groupId: string;
  bookingId: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  location: string | null;
  description: string | null;
  createdByUserId?: string | null;
  reminderAt?: Date | null;
}

export type EventPatch = Partial<Pick<CalendarEvent, "title" | "startsAt" | "endsAt" | "allDay" | "location" | "description" | "status" | "reminderAt">>;

export interface CreateDecisionInput {
  groupId: string;
  kind: string;
  question: string;
  createdByUserId: string | null;
  deadlineAt: Date | null;
  round: number;
  parentDecisionId: string | null;
  /** In order: position 1, 2, ... */
  optionIds: string[];
}

export type DecisionPatch = Partial<Pick<Decision, "status" | "winningOptionId" | "deadlineAt" | "tieBreakUserId" | "nudgeSentAt">>;

export interface CreatePendingQuestionInput {
  groupId: string;
  askedUserId: string;
  nodProviderMessageId: string;
  question: string;
  remaining: number;
  expiresAt: Date;
}

export interface CreateSearchInput {
  groupId: string | null;
  requestedByUserId: string | null;
  query: string;
  location: string | null;
  whenText: string | null;
  results: Record<string, unknown>;
}

export interface UpsertOptionInput {
  groupId: string;
  kind: Option["kind"];
  source: Option["source"];
  url: string;
  postedByUserId: string | null;
  providerMessageId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RetentionPolicy {
  maxMessages: number;
  maxAgeDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { maxMessages: 200, maxAgeDays: 30 };

export type ChatScope = { groupId: string } | { dmUserId: string };

export interface SaveMessageInput {
  provider: string;
  providerMessageId: string;
  groupId: string | null;
  dmUserId: string | null;
  senderUserId: string | null;
  fromNod: boolean;
  text: string | null;
  mediaUrls: string[];
  service: Service;
  replyToProviderMessageId: string | null;
  addressed: boolean;
  createdAt: Date;
}

export interface KnownPerson {
  name: string;
  phone: Phone;
}

export interface ChatMember {
  userId: string;
  name: string | null;
  phone: Phone;
  optedOut: boolean;
}

export interface RecentOptions {
  /** Internal message id to leave out. */
  excludeId?: string;
  /** Provider message id to leave out (the message being answered). */
  excludeProviderMessageId?: string;
}

export interface ReactionInput {
  provider: string;
  targetProviderMessageId: string;
  userId: string;
  reaction: Tapback;
  removed: boolean;
}

/** Everything the app persists. `DrizzleStore` is production; `MemoryStore` runs the same contract in memory. */
export interface Store {
  upsertUser(phone: Phone): Promise<User>;
  getUser(id: string): Promise<User | undefined>;
  setUserName(userId: string, name: string): Promise<void>;
  setUserAccess(userId: string, status: User["accessStatus"]): Promise<void>;
  /** True the first time only: personal setup goes out once per person. */
  claimSetup(userId: string): Promise<boolean>;

  upsertGroup(input: { provider: string; providerGroupId: string; name?: string }): Promise<{ group: Group; created: boolean }>;
  getGroup(id: string): Promise<Group | undefined>;
  groupByProviderId(provider: string, providerGroupId: string): Promise<Group | undefined>;
  setGroupJoined(groupId: string, at: Date): Promise<void>;
  setAddedBy(groupId: string, userId: string): Promise<void>;
  /** True the first time only, per join: exactly one introduction. */
  claimIntro(groupId: string): Promise<boolean>;
  resetIntro(groupId: string): Promise<void>;
  markUnsupported(groupId: string): Promise<void>;
  /** A group Nod created itself: its creation message was the introduction. */
  markCreatedByNod(groupId: string, requesterUserId: string): Promise<void>;
  latestUnsupportedGroupFor(userId: string, since: Date): Promise<Group | undefined>;
  addMembers(groupId: string, userIds: string[]): Promise<void>;
  memberPhones(groupId: string): Promise<Phone[]>;
  groupMembers(groupId: string): Promise<ChatMember[]>;
  setOptedOut(groupId: string, userId: string, optedOut: boolean): Promise<void>;
  /** Clears the text and attachments of this member's stored messages in the group (rows stay, to dedupe webhook retries), and their open follow-up questions. Returns how many messages had content. */
  forgetMemberMessages(groupId: string, userId: string): Promise<number>;
  /** This member's settings-link token for the group, made on first use. Undefined if they aren't a member. */
  memberSettingsToken(groupId: string, userId: string, makeToken: () => string): Promise<string | undefined>;
  memberByToken(token: string): Promise<{ groupId: string; userId: string } | undefined>;
  isOptedOut(groupId: string, userId: string): Promise<boolean>;

  saveContacts(ownerUserId: string, people: KnownPerson[]): Promise<void>;
  /** Matches the owner's shared contacts, then named people who share a chat with them. */
  findKnownPeople(ownerUserId: string, name: string): Promise<KnownPerson[]>;

  saveMessage(input: SaveMessageInput): Promise<{ saved: boolean; duplicate: boolean; id?: string }>;
  setMessageText(id: string, text: string): Promise<void>;
  setAddressed(id: string, addressed: boolean): Promise<void>;
  hasMessage(provider: string, providerMessageId: string): Promise<boolean>;
  isFromNod(provider: string, providerMessageId: string): Promise<boolean>;
  recentMessages(scope: ChatScope, limit: number, opts?: RecentOptions): Promise<RecentMessage[]>;
  setReaction(input: ReactionInput): Promise<boolean>;

  /** One option per URL per group; a repeat post returns the existing one. */
  upsertOption(input: UpsertOptionInput): Promise<{ option: Option; created: boolean }>;
  getOption(id: string): Promise<Option | undefined>;
  listOptions(groupId: string, filter?: { kind?: Option["kind"] }): Promise<Option[]>;
  /** Shallow-merges into `parsed`. */
  updateOptionParsed(id: string, patch: Record<string, unknown>): Promise<void>;

  createSearch(input: CreateSearchInput): Promise<Search>;
  getSearch(id: string): Promise<Search | undefined>;
  /** Searches in a group, or a person's private searches, since a time (rate limiting). */
  countSearchesSince(scope: ChatScope, since: Date): Promise<number>;

  createPendingQuestion(input: CreatePendingQuestionInput): Promise<PendingQuestion>;
  /** The newest question to this person in this group that hasn't expired or been used up at `at`. */
  activePendingQuestion(groupId: string, userId: string, at: Date): Promise<PendingQuestion | undefined>;
  setPendingQuestionRemaining(id: string, remaining: number): Promise<void>;

  setGroupTimezone(groupId: string, timezone: string): Promise<void>;
  setGroupOrganizer(groupId: string, userId: string | null): Promise<void>;
  // Group notes and "forget this chat" (step 15)
  createGroupNote(input: { groupId: string; subjectUserId: string | null; note: string; kind: "must_have" | "preference"; createdByUserId: string | null }): Promise<GroupNote>;
  /** Oldest first. */
  listGroupNotes(groupId: string): Promise<GroupNote[]>;
  deleteGroupNote(id: string): Promise<boolean>;
  /** Deletes a group's stored messages, notes, open follow-up questions and receipt photos. Money records (the tab, bookings, payments) stay. */
  forgetGroup(groupId: string): Promise<{ messages: number; notes: number }>;
  createDecision(input: CreateDecisionInput): Promise<Decision>;
  getDecision(id: string): Promise<Decision | undefined>;
  decisionOptions(decisionId: string): Promise<Array<{ position: number; optionId: string }>>;
  /** The group's open decision, if any (one at a time). */
  openDecision(groupId: string): Promise<Decision | undefined>;
  /** Open decisions in every group this person belongs to (for private replies). */
  openDecisionsForUser(userId: string): Promise<Decision[]>;
  /** Newest first. */
  listDecisions(groupId: string): Promise<Decision[]>;
  updateDecision(id: string, patch: DecisionPatch): Promise<void>;
  /** Applies the patch only if the status is one of `from`. True if it did (so a result is posted once). */
  transitionDecision(id: string, from: Decision["status"][], patch: DecisionPatch): Promise<boolean>;
  /** Date polls (step 12): the choices, in order. */
  addDatePollChoices(decisionId: string, choices: Array<{ startsOn: string; endsOn: string | null }>): Promise<void>;
  datePollChoices(decisionId: string): Promise<DatePollChoice[]>;
  markDatePollChoice(decisionId: string, position: number): Promise<void>;
  setDatePollChoiceMessage(decisionId: string, position: number, providerMessageId: string): Promise<void>;
  datePollChoiceByMessage(providerMessageId: string): Promise<DatePollChoice | undefined>;
  setDatePollResponse(decisionId: string, userId: string, positions: number[]): Promise<void>;
  datePollResponses(decisionId: string): Promise<Array<{ userId: string; positions: number[] }>>;
  setVote(decisionId: string, userId: string, optionId: string): Promise<void>;
  /** Removes this person's vote only if it's for `optionId` (e.g. they removed that tapback). */
  removeVote(decisionId: string, userId: string, optionId: string): Promise<void>;
  votesFor(decisionId: string): Promise<Array<{ userId: string; optionId: string }>>;
  /** The option first posted in this message (tapback votes). */
  optionByMessage(groupId: string, providerMessageId: string): Promise<Option | undefined>;
  setDecisionOptionMessage(decisionId: string, optionId: string, providerMessageId: string): Promise<void>;
  /** The vote option whose own message this is (Nod posts each option as a separate message). */
  decisionOptionByMessage(providerMessageId: string): Promise<{ decisionId: string; optionId: string; position: number } | undefined>;
  /** Newest stored message in the group with exactly this text (SMS tapback text quotes it). */
  findMessageIdByText(groupId: string, text: string): Promise<string | undefined>;

  createBooking(input: CreateBookingInput): Promise<Booking>;
  getBooking(id: string): Promise<Booking | undefined>;
  updateBooking(id: string, patch: BookingPatch): Promise<void>;
  /** Newest first. */
  listBookings(groupId: string): Promise<Booking[]>;
  /** Applies the patch only if the booking's status is one of `from`. True if it did (so only one caller books). */
  transitionBooking(id: string, from: BookingStatus[], patch: BookingPatch): Promise<boolean>;
  /** The group's newest proposed booking, if any. */
  openProposal(groupId: string): Promise<Booking | undefined>;
  bookingByProposalMessage(groupId: string, providerMessageId: string): Promise<Booking | undefined>;
  addBookingApproval(bookingId: string, userId: string): Promise<void>;
  removeBookingApproval(bookingId: string, userId: string): Promise<void>;
  clearBookingApprovals(bookingId: string): Promise<void>;
  /** User ids, oldest approval first. */
  bookingApprovals(bookingId: string): Promise<string[]>;
  /** Sets reminder_sent_at if unset. True if this call claimed it. */
  claimBookingReminder(id: string): Promise<boolean>;
  createEvent(input: CreateEventInput): Promise<CalendarEvent>;

  // Payments (step 10)
  setStripeAccount(userId: string, accountId: string): Promise<void>;
  /** Marks the account ready or not; returns its owner. */
  setStripeAccountReady(accountId: string, ready: boolean): Promise<User | undefined>;
  userByPayoutToken(token: string): Promise<User | undefined>;
  /** Sets the payout token if unset; returns the one stored. */
  ensurePayoutToken(userId: string, token: string): Promise<string>;
  createCollection(input: CreateCollectionInput): Promise<{ collection: PaymentCollection; requests: PaymentRequest[] }>;
  getCollection(id: string): Promise<PaymentCollection | undefined>;
  /** Newest first. */
  listCollections(groupId: string): Promise<PaymentCollection[]>;
  /** Collections waiting on this payee's payout setup. */
  collectionsAwaitingPayee(userId: string): Promise<PaymentCollection[]>;
  /** Open (setup or collecting) collections this person pays into or receives. */
  openCollectionsForUser(userId: string): Promise<PaymentCollection[]>;
  updateCollection(id: string, patch: CollectionPatch): Promise<void>;
  /** Applies the patch only if the status is one of `from`. True if it did. */
  transitionCollection(id: string, from: PaymentCollection["status"][], patch: CollectionPatch): Promise<boolean>;
  collectionByMessage(groupId: string, providerMessageId: string): Promise<PaymentCollection | undefined>;
  claimCollectionReminder(id: string): Promise<boolean>;
  paymentRequests(collectionId: string): Promise<PaymentRequest[]>;
  getPaymentRequest(id: string): Promise<PaymentRequest | undefined>;
  paymentRequestByToken(token: string): Promise<PaymentRequest | undefined>;
  paymentRequestByIntent(intentId: string): Promise<PaymentRequest | undefined>;
  /** Applies the patch only if the status is one of `from`. True if it did (so only one caller charges a card). */
  transitionPaymentRequest(id: string, from: PaymentRequestStatus[], patch: PaymentRequestPatch): Promise<boolean>;
  /** Stores the hold's PaymentIntent if the request has none yet. True if this call stored it. */
  setPaymentIntent(id: string, intentId: string): Promise<boolean>;
  addPaymentApproval(collectionId: string, userId: string): Promise<void>;
  removePaymentApproval(collectionId: string, userId: string): Promise<void>;
  paymentApprovals(collectionId: string): Promise<string[]>;

  // The tab (step 11)
  /** Undefined when an entry from the same source already exists (so a booking deposit or payment is never counted twice). */
  createLedgerEntry(input: CreateLedgerEntryInput): Promise<LedgerEntryWithShares | undefined>;
  getLedgerEntry(id: string): Promise<LedgerEntryWithShares | undefined>;
  /** Groups this person is a member of. */
  groupsForUser(userId: string): Promise<Group[]>;
  /** Oldest first; voided entries left out. */
  listLedger(groupId: string): Promise<LedgerEntryWithShares[]>;
  /** True if this call voided it. */
  voidLedgerEntry(id: string): Promise<boolean>;
  createReceipt(input: { groupId: string; uploadedByUserId: string | null; imageUrl: string; parsed: ParsedReceipt }): Promise<Receipt>;
  getReceipt(id: string): Promise<Receipt | undefined>;
  /** Photos and files posted in a group since a time, newest first. */
  recentMedia(groupId: string, since: Date): Promise<Array<{ url: string; senderUserId: string | null; at: Date }>>;
  getEvent(id: string): Promise<CalendarEvent | undefined>;
  /** Applies the change and bumps the event's sequence number. Returns the updated event. */
  updateEvent(id: string, patch: EventPatch): Promise<CalendarEvent | undefined>;
  /** The group's events, soonest first. */
  listEvents(groupId: string): Promise<CalendarEvent[]>;
  eventsForBooking(bookingId: string): Promise<CalendarEvent[]>;
  /** Sets reminder_sent_at if unset. True if this call claimed it. */
  claimEventReminder(id: string): Promise<boolean>;
  reactionsFor(provider: string, providerMessageId: string): Promise<Record<string, string>>;

  // ---- reply progress (retries) ----
  /** Starts or resumes a reply: creates the row or counts one more attempt. Returns it. Prunes rows older than two days. */
  beginReply(key: string, groupId: string | null): Promise<Reply>;
  saveReply(key: string, patch: ReplyPatch): Promise<void>;

  // ---- invites (step 16) ----
  /** Undefined when the code is already taken (the caller picks another). */
  createInvite(input: { code: string; issuedByUserId: string | null; source: InviteSource; eventId?: string | null }): Promise<Invite | undefined>;
  inviteByCode(code: string): Promise<Invite | undefined>;
  /** Marks the code redeemed by this person if nobody has used it yet. Undefined if it was already used or doesn't exist. */
  redeemInvite(code: string, userId: string): Promise<Invite | undefined>;
  setInvitesRemaining(userId: string, count: number): Promise<void>;
  /** Uses one of this person's invites. False when they have none left. */
  takeInvite(userId: string): Promise<boolean>;
  /** The post-trip code issued to this person for this event, if any. */
  postTripInvite(eventId: string, userId: string): Promise<Invite | undefined>;
  markInviteNotified(id: string): Promise<void>;
  /** Codes this person was given that nobody has redeemed yet, oldest first. */
  unredeemedInvites(userId: string, source?: InviteSource): Promise<Invite[]>;
  joinWaitlist(phone: Phone): Promise<{ entry: WaitlistEntry; created: boolean }>;
  waitlistEntry(phone: Phone): Promise<WaitlistEntry | undefined>;
  leaveWaitlist(phone: Phone): Promise<void>;
  /** People still waiting for a code, longest wait first. */
  nextOnWaitlist(limit: number): Promise<WaitlistEntry[]>;
  markWaitlistNotified(phone: Phone): Promise<void>;
  /** Counts a wrong code (joining the waitlist if needed); the count restarts when the last window began before windowStart. Returns the count. */
  recordFailedCode(phone: Phone, windowStart: Date): Promise<number>;
  /** Confirmed all-day events that ended in [since, until] and haven't had post-trip invites. */
  endedTrips(since: Date, until: Date): Promise<CalendarEvent[]>;
  /** Sets wrap_sent_at if unset. True if this call claimed it. */
  claimEventWrap(id: string): Promise<boolean>;
}

/** True when `query` names this person: the full name, or their first name. */
export function nameMatches(fullName: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  const n = fullName.trim().toLowerCase();
  return q.length > 0 && (n === q || n.split(/\s+/)[0] === q);
}

export class DrizzleStore implements Store {
  private readonly retention: RetentionPolicy;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    opts: { retention?: RetentionPolicy; now?: () => Date } = {},
  ) {
    this.retention = opts.retention ?? DEFAULT_RETENTION;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- users and groups ----

  async upsertUser(phone: Phone): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({ phone })
      .onConflictDoUpdate({ target: users.phone, set: { phone } })
      .returning();
    return row!;
  }

  async getUser(id: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row;
  }

  async setUserName(userId: string, name: string): Promise<void> {
    await this.db.update(users).set({ name }).where(eq(users.id, userId));
  }

  async setUserAccess(userId: string, status: User["accessStatus"]): Promise<void> {
    await this.db.update(users).set({ accessStatus: status }).where(eq(users.id, userId));
  }

  async claimSetup(userId: string): Promise<boolean> {
    const rows = await this.db
      .update(users)
      .set({ setupSentAt: this.now() })
      .where(and(eq(users.id, userId), isNull(users.setupSentAt)))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  async upsertGroup(input: { provider: string; providerGroupId: string; name?: string }): Promise<{ group: Group; created: boolean }> {
    const [inserted] = await this.db
      .insert(groups)
      .values({ provider: input.provider, providerGroupId: input.providerGroupId, name: input.name })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { group: inserted, created: true };
    const group = (await this.groupByProviderId(input.provider, input.providerGroupId))!;
    if (input.name && input.name !== group.name) {
      const [renamed] = await this.db.update(groups).set({ name: input.name }).where(eq(groups.id, group.id)).returning();
      return { group: renamed!, created: false };
    }
    return { group, created: false };
  }

  async groupByProviderId(provider: string, providerGroupId: string): Promise<Group | undefined> {
    const [row] = await this.db
      .select()
      .from(groups)
      .where(and(eq(groups.provider, provider), eq(groups.providerGroupId, providerGroupId)));
    return row;
  }

  async getGroup(id: string): Promise<Group | undefined> {
    const [row] = await this.db.select().from(groups).where(eq(groups.id, id));
    return row;
  }

  async setGroupJoined(groupId: string, at: Date): Promise<void> {
    await this.db.update(groups).set({ joinedAt: at, unsupportedAt: null }).where(eq(groups.id, groupId));
  }

  async setAddedBy(groupId: string, userId: string): Promise<void> {
    await this.db.update(groups).set({ addedByUserId: userId }).where(eq(groups.id, groupId));
  }

  async claimIntro(groupId: string): Promise<boolean> {
    const rows = await this.db
      .update(groups)
      .set({ introSentAt: this.now() })
      .where(and(eq(groups.id, groupId), isNull(groups.introSentAt)))
      .returning({ id: groups.id });
    return rows.length > 0;
  }

  async resetIntro(groupId: string): Promise<void> {
    await this.db.update(groups).set({ introSentAt: null }).where(eq(groups.id, groupId));
  }

  async markUnsupported(groupId: string): Promise<void> {
    await this.db.update(groups).set({ unsupportedAt: this.now() }).where(eq(groups.id, groupId));
  }

  async markCreatedByNod(groupId: string, requesterUserId: string): Promise<void> {
    const at = this.now();
    await this.db
      .update(groups)
      .set({ createdByNod: true, addedByUserId: requesterUserId, joinedAt: at, introSentAt: at })
      .where(eq(groups.id, groupId));
  }

  async latestUnsupportedGroupFor(userId: string, since: Date): Promise<Group | undefined> {
    const [row] = await this.db
      .select()
      .from(groups)
      .where(and(eq(groups.addedByUserId, userId), isNotNull(groups.unsupportedAt), gte(groups.unsupportedAt, since)))
      .orderBy(desc(groups.unsupportedAt))
      .limit(1);
    return row;
  }

  async addMembers(groupId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    await this.db
      .insert(groupMembers)
      .values(userIds.map((userId) => ({ groupId, userId })))
      .onConflictDoNothing();
  }

  async memberPhones(groupId: string): Promise<Phone[]> {
    const rows = await this.db
      .select({ phone: users.phone })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, groupId));
    return rows.map((r) => r.phone);
  }

  async groupMembers(groupId: string): Promise<ChatMember[]> {
    return this.db
      .select({ userId: users.id, name: users.name, phone: users.phone, optedOut: groupMembers.optedOut })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, groupId));
  }

  async forgetMemberMessages(groupId: string, userId: string): Promise<number> {
    if (!UUID.test(groupId) || !UUID.test(userId)) return 0;
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(messages)
        .set({ text: null, mediaUrls: [] })
        .where(
          and(
            eq(messages.groupId, groupId),
            eq(messages.senderUserId, userId),
            or(not(isNull(messages.text)), sql`jsonb_array_length(${messages.mediaUrls}) > 0`),
          ),
        )
        .returning({ id: messages.id });
      await tx.delete(pendingQuestions).where(and(eq(pendingQuestions.groupId, groupId), eq(pendingQuestions.askedUserId, userId)));
      return rows.length;
    });
  }

  async memberSettingsToken(groupId: string, userId: string, makeToken: () => string): Promise<string | undefined> {
    if (!UUID.test(groupId) || !UUID.test(userId)) return undefined;
    const where = and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId));
    await this.db.update(groupMembers).set({ settingsToken: makeToken() }).where(and(where, isNull(groupMembers.settingsToken)));
    const [row] = await this.db.select({ token: groupMembers.settingsToken }).from(groupMembers).where(where);
    return row?.token ?? undefined;
  }

  async memberByToken(token: string): Promise<{ groupId: string; userId: string } | undefined> {
    if (!token || token.length > 100) return undefined;
    const [row] = await this.db
      .select({ groupId: groupMembers.groupId, userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.settingsToken, token));
    return row;
  }

  async setOptedOut(groupId: string, userId: string, optedOut: boolean): Promise<void> {
    await this.db
      .insert(groupMembers)
      .values({ groupId, userId, optedOut })
      .onConflictDoUpdate({ target: [groupMembers.groupId, groupMembers.userId], set: { optedOut } });
  }

  async isOptedOut(groupId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ optedOut: groupMembers.optedOut })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
    return row?.optedOut ?? false;
  }

  // ---- people ----

  async saveContacts(ownerUserId: string, people: KnownPerson[]): Promise<void> {
    if (!people.length) return;
    await this.db
      .insert(userContacts)
      .values(people.map((p) => ({ ownerUserId, name: p.name, phone: p.phone })))
      .onConflictDoUpdate({ target: [userContacts.ownerUserId, userContacts.phone], set: { name: sql`excluded.name` } });
  }

  async findKnownPeople(ownerUserId: string, name: string): Promise<KnownPerson[]> {
    const contacts = await this.db
      .select({ name: userContacts.name, phone: userContacts.phone })
      .from(userContacts)
      .where(eq(userContacts.ownerUserId, ownerUserId));
    const found = contacts.filter((c) => nameMatches(c.name, name));
    if (found.length) return found;

    const myGroups = this.db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, ownerUserId));
    const peers = await this.db
      .selectDistinct({ name: users.name, phone: users.phone })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(inArray(groupMembers.groupId, myGroups), not(eq(users.id, ownerUserId)), isNotNull(users.name)));
    return peers.filter((p) => nameMatches(p.name!, name)).map((p) => ({ name: p.name!, phone: p.phone }));
  }

  // ---- messages ----

  /** Inserts once per provider message id, then applies retention to that chat. */
  async saveMessage(input: SaveMessageInput): Promise<{ saved: boolean; duplicate: boolean; id?: string }> {
    const [row] = await this.db.insert(messages).values(input).onConflictDoNothing().returning({ id: messages.id });
    if (!row) return { saved: false, duplicate: true };
    if (input.groupId) await this.prune({ groupId: input.groupId });
    else if (input.dmUserId) await this.prune({ dmUserId: input.dmUserId });
    return { saved: true, duplicate: false, id: row.id };
  }

  async setMessageText(id: string, text: string): Promise<void> {
    await this.db.update(messages).set({ text }).where(eq(messages.id, id));
  }

  async setAddressed(id: string, addressed: boolean): Promise<void> {
    await this.db.update(messages).set({ addressed }).where(eq(messages.id, id));
  }

  async hasMessage(provider: string, providerMessageId: string): Promise<boolean> {
    return (await this.findMessage(provider, providerMessageId)) !== undefined;
  }

  async isFromNod(provider: string, providerMessageId: string): Promise<boolean> {
    return (await this.findMessage(provider, providerMessageId))?.fromNod ?? false;
  }

  /** Oldest-first, skipping redacted messages and opted-out members (except their calls to Nod). */
  async recentMessages(scope: ChatScope, limit: number, opts: RecentOptions = {}): Promise<RecentMessage[]> {
    const conds: SQL[] = [this.scopeCond(scope), not(isNull(messages.text))];
    if (opts.excludeId) conds.push(not(eq(messages.id, opts.excludeId)));
    if (opts.excludeProviderMessageId) conds.push(not(eq(messages.providerMessageId, opts.excludeProviderMessageId)));
    if ("groupId" in scope) {
      conds.push(
        sql`(${messages.addressed} or not exists (select 1 from ${groupMembers} gm
            where gm.group_id = ${messages.groupId} and gm.user_id = ${messages.senderUserId} and gm.opted_out))`,
      );
    }
    const rows = await this.db
      .select({ text: messages.text, fromNod: messages.fromNod, name: users.name, phone: users.phone })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.senderUserId))
      .where(and(...conds))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(limit);
    return rows.reverse().map((r) => ({ from: r.fromNod ? "Nod" : (r.name ?? r.phone ?? "unknown"), text: r.text! }));
  }

  // ---- reactions ----

  /** Returns false when the target message isn't stored (e.g. sent before Nod joined). */
  async setReaction(input: ReactionInput): Promise<boolean> {
    const next = input.removed
      ? sql`${messages.reactions} - ${input.userId}::text`
      : sql`${messages.reactions} || jsonb_build_object(${input.userId}::text, ${input.reaction}::text)`;
    const rows = await this.db
      .update(messages)
      .set({ reactions: next })
      .where(and(eq(messages.provider, input.provider), eq(messages.providerMessageId, input.targetProviderMessageId)))
      .returning({ id: messages.id });
    return rows.length > 0;
  }

  async reactionsFor(provider: string, providerMessageId: string): Promise<Record<string, string>> {
    return (await this.findMessage(provider, providerMessageId))?.reactions ?? {};
  }

  // ---- options ----

  async upsertOption(input: UpsertOptionInput): Promise<{ option: Option; created: boolean }> {
    const at = this.now();
    const [inserted] = await this.db
      .insert(options)
      .values({ ...input, createdAt: at, updatedAt: at })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { option: inserted, created: true };
    const [existing] = await this.db
      .select()
      .from(options)
      .where(and(eq(options.groupId, input.groupId), eq(options.url, input.url)));
    return { option: existing!, created: false };
  }

  async getOption(id: string): Promise<Option | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.select().from(options).where(eq(options.id, id));
    return row;
  }

  async listOptions(groupId: string, filter: { kind?: Option["kind"] } = {}): Promise<Option[]> {
    const conds = [eq(options.groupId, groupId)];
    if (filter.kind) conds.push(eq(options.kind, filter.kind));
    return this.db
      .select()
      .from(options)
      .where(and(...conds))
      .orderBy(options.createdAt, options.seq);
  }

  async updateOptionParsed(id: string, patch: Record<string, unknown>): Promise<void> {
    if (!UUID.test(id)) return;
    await this.db
      .update(options)
      .set({ parsed: sql`${options.parsed} || ${JSON.stringify(patch)}::jsonb`, updatedAt: this.now() })
      .where(eq(options.id, id));
  }

  // ---- searches ----

  async createSearch(input: CreateSearchInput): Promise<Search> {
    const [row] = await this.db.insert(searches).values({ ...input, createdAt: this.now() }).returning();
    return row!;
  }

  async getSearch(id: string): Promise<Search | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.select().from(searches).where(eq(searches.id, id));
    return row;
  }

  async countSearchesSince(scope: ChatScope, since: Date): Promise<number> {
    const who =
      "groupId" in scope
        ? eq(searches.groupId, scope.groupId)
        : and(isNull(searches.groupId), eq(searches.requestedByUserId, scope.dmUserId))!;
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(searches)
      .where(and(who, gte(searches.createdAt, since)));
    return row?.n ?? 0;
  }

  // ---- pending questions ----

  async createPendingQuestion(input: CreatePendingQuestionInput): Promise<PendingQuestion> {
    const [row] = await this.db.insert(pendingQuestions).values({ ...input, createdAt: this.now() }).returning();
    return row!;
  }

  async activePendingQuestion(groupId: string, userId: string, at: Date): Promise<PendingQuestion | undefined> {
    const [row] = await this.db
      .select()
      .from(pendingQuestions)
      .where(
        and(
          eq(pendingQuestions.groupId, groupId),
          eq(pendingQuestions.askedUserId, userId),
          sql`${pendingQuestions.expiresAt} > ${at.toISOString()}`,
          sql`${pendingQuestions.remaining} > 0`,
        ),
      )
      .orderBy(desc(pendingQuestions.createdAt))
      .limit(1);
    return row;
  }

  async setPendingQuestionRemaining(id: string, remaining: number): Promise<void> {
    await this.db.update(pendingQuestions).set({ remaining }).where(eq(pendingQuestions.id, id));
  }

  // ---- decisions and votes ----

  async setGroupTimezone(groupId: string, timezone: string): Promise<void> {
    await this.db.update(groups).set({ timezone }).where(eq(groups.id, groupId));
  }

  async setGroupOrganizer(groupId: string, userId: string | null): Promise<void> {
    await this.db.update(groups).set({ organizerUserId: userId }).where(eq(groups.id, groupId));
  }

  async createGroupNote(input: { groupId: string; subjectUserId: string | null; note: string; kind: "must_have" | "preference"; createdByUserId: string | null }): Promise<GroupNote> {
    const [row] = await this.db.insert(groupNotes).values({ ...input, createdAt: this.now() }).returning();
    return row!;
  }

  async listGroupNotes(groupId: string): Promise<GroupNote[]> {
    return this.db.select().from(groupNotes).where(eq(groupNotes.groupId, groupId)).orderBy(asc(groupNotes.createdAt), asc(groupNotes.seq));
  }

  async deleteGroupNote(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const rows = await this.db.delete(groupNotes).where(eq(groupNotes.id, id)).returning({ id: groupNotes.id });
    return rows.length > 0;
  }

  async forgetGroup(groupId: string): Promise<{ messages: number; notes: number }> {
    return this.db.transaction(async (tx) => {
      const m = await tx.delete(messages).where(eq(messages.groupId, groupId)).returning({ id: messages.id });
      const n = await tx.delete(groupNotes).where(eq(groupNotes.groupId, groupId)).returning({ id: groupNotes.id });
      await tx.delete(pendingQuestions).where(eq(pendingQuestions.groupId, groupId));
      await tx.delete(receipts).where(eq(receipts.groupId, groupId));
      await tx.delete(replies).where(eq(replies.groupId, groupId));
      return { messages: m.length, notes: n.length };
    });
  }

  async createDecision(input: CreateDecisionInput): Promise<Decision> {
    const at = this.now();
    const { optionIds, ...fields } = input;
    const [row] = await this.db.insert(decisions).values({ ...fields, createdAt: at, updatedAt: at }).returning();
    if (optionIds.length) {
      await this.db.insert(decisionOptions).values(optionIds.map((optionId, i) => ({ decisionId: row!.id, optionId, position: i + 1 })));
    }
    return row!;
  }

  async getDecision(id: string): Promise<Decision | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.select().from(decisions).where(eq(decisions.id, id));
    return row;
  }

  async decisionOptions(decisionId: string) {
    return this.db
      .select({ position: decisionOptions.position, optionId: decisionOptions.optionId })
      .from(decisionOptions)
      .where(eq(decisionOptions.decisionId, decisionId))
      .orderBy(decisionOptions.position);
  }

  async openDecision(groupId: string): Promise<Decision | undefined> {
    const [row] = await this.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.groupId, groupId), eq(decisions.status, "open")))
      .orderBy(desc(decisions.createdAt))
      .limit(1);
    return row;
  }

  async openDecisionsForUser(userId: string): Promise<Decision[]> {
    const mine = this.db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId));
    return this.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.status, "open"), inArray(decisions.groupId, mine)))
      .orderBy(desc(decisions.createdAt));
  }

  async listDecisions(groupId: string): Promise<Decision[]> {
    return this.db.select().from(decisions).where(eq(decisions.groupId, groupId)).orderBy(desc(decisions.createdAt));
  }

  async updateDecision(id: string, patch: DecisionPatch): Promise<void> {
    await this.db.update(decisions).set({ ...patch, updatedAt: this.now() }).where(eq(decisions.id, id));
  }

  async transitionDecision(id: string, from: Decision["status"][], patch: DecisionPatch): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const rows = await this.db
      .update(decisions)
      .set({ ...patch, updatedAt: this.now() })
      .where(and(eq(decisions.id, id), inArray(decisions.status, from)))
      .returning({ id: decisions.id });
    return rows.length > 0;
  }

  async addDatePollChoices(decisionId: string, choices: Array<{ startsOn: string; endsOn: string | null }>): Promise<void> {
    await this.db.insert(datePollChoices).values(choices.map((c, i) => ({ ...c, decisionId, position: i + 1 })));
  }

  async datePollChoices(decisionId: string): Promise<DatePollChoice[]> {
    return this.db.select().from(datePollChoices).where(eq(datePollChoices.decisionId, decisionId)).orderBy(asc(datePollChoices.position));
  }

  async markDatePollChoice(decisionId: string, position: number): Promise<void> {
    await this.db.update(datePollChoices).set({ chosen: true }).where(and(eq(datePollChoices.decisionId, decisionId), eq(datePollChoices.position, position)));
  }

  async setDatePollChoiceMessage(decisionId: string, position: number, providerMessageId: string): Promise<void> {
    await this.db
      .update(datePollChoices)
      .set({ messageId: providerMessageId })
      .where(and(eq(datePollChoices.decisionId, decisionId), eq(datePollChoices.position, position)));
  }

  async datePollChoiceByMessage(providerMessageId: string): Promise<DatePollChoice | undefined> {
    const [row] = await this.db.select().from(datePollChoices).where(eq(datePollChoices.messageId, providerMessageId));
    return row;
  }

  async setDatePollResponse(decisionId: string, userId: string, positions: number[]): Promise<void> {
    await this.db
      .insert(datePollResponses)
      .values({ decisionId, userId, positions, updatedAt: this.now() })
      .onConflictDoUpdate({ target: [datePollResponses.decisionId, datePollResponses.userId], set: { positions, updatedAt: this.now() } });
  }

  async datePollResponses(decisionId: string): Promise<Array<{ userId: string; positions: number[] }>> {
    return this.db
      .select({ userId: datePollResponses.userId, positions: datePollResponses.positions })
      .from(datePollResponses)
      .where(eq(datePollResponses.decisionId, decisionId))
      .orderBy(asc(datePollResponses.updatedAt));
  }

  async setVote(decisionId: string, userId: string, optionId: string): Promise<void> {
    await this.db
      .insert(votes)
      .values({ decisionId, userId, optionId, createdAt: this.now() })
      .onConflictDoUpdate({ target: [votes.decisionId, votes.userId], set: { optionId, createdAt: this.now() } });
  }

  async removeVote(decisionId: string, userId: string, optionId: string): Promise<void> {
    await this.db.delete(votes).where(and(eq(votes.decisionId, decisionId), eq(votes.userId, userId), eq(votes.optionId, optionId)));
  }

  async votesFor(decisionId: string) {
    return this.db.select({ userId: votes.userId, optionId: votes.optionId }).from(votes).where(eq(votes.decisionId, decisionId));
  }

  async setDecisionOptionMessage(decisionId: string, optionId: string, providerMessageId: string): Promise<void> {
    await this.db
      .update(decisionOptions)
      .set({ messageId: providerMessageId })
      .where(and(eq(decisionOptions.decisionId, decisionId), eq(decisionOptions.optionId, optionId)));
  }

  async decisionOptionByMessage(providerMessageId: string) {
    const [row] = await this.db
      .select({ decisionId: decisionOptions.decisionId, optionId: decisionOptions.optionId, position: decisionOptions.position })
      .from(decisionOptions)
      .where(eq(decisionOptions.messageId, providerMessageId));
    return row;
  }

  async optionByMessage(groupId: string, providerMessageId: string): Promise<Option | undefined> {
    const [row] = await this.db
      .select()
      .from(options)
      .where(and(eq(options.groupId, groupId), eq(options.providerMessageId, providerMessageId)));
    return row;
  }

  async findMessageIdByText(groupId: string, text: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ id: messages.providerMessageId })
      .from(messages)
      .where(and(eq(messages.groupId, groupId), eq(messages.text, text)))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(1);
    return row?.id;
  }

  // ---- bookings and events ----

  async createBooking(input: CreateBookingInput): Promise<Booking> {
    const at = this.now();
    const [row] = await this.db.insert(bookings).values({ ...input, createdAt: at, updatedAt: at }).returning();
    return row!;
  }

  async getBooking(id: string): Promise<Booking | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.select().from(bookings).where(eq(bookings.id, id));
    return row;
  }

  async updateBooking(id: string, patch: BookingPatch): Promise<void> {
    await this.db.update(bookings).set({ ...patch, updatedAt: this.now() }).where(eq(bookings.id, id));
  }

  async listBookings(groupId: string): Promise<Booking[]> {
    return this.db.select().from(bookings).where(eq(bookings.groupId, groupId)).orderBy(desc(bookings.createdAt));
  }

  async transitionBooking(id: string, from: BookingStatus[], patch: BookingPatch): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const rows = await this.db
      .update(bookings)
      .set({ ...patch, updatedAt: this.now() })
      .where(and(eq(bookings.id, id), inArray(bookings.status, from)))
      .returning({ id: bookings.id });
    return rows.length > 0;
  }

  async openProposal(groupId: string): Promise<Booking | undefined> {
    const [row] = await this.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.groupId, groupId), eq(bookings.status, "proposed")))
      .orderBy(desc(bookings.createdAt))
      .limit(1);
    return row;
  }

  async bookingByProposalMessage(groupId: string, providerMessageId: string): Promise<Booking | undefined> {
    const [row] = await this.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.groupId, groupId), eq(bookings.proposalMessageId, providerMessageId)));
    return row;
  }

  async addBookingApproval(bookingId: string, userId: string): Promise<void> {
    await this.db.insert(bookingApprovals).values({ bookingId, userId, createdAt: this.now() }).onConflictDoNothing();
  }

  async removeBookingApproval(bookingId: string, userId: string): Promise<void> {
    await this.db.delete(bookingApprovals).where(and(eq(bookingApprovals.bookingId, bookingId), eq(bookingApprovals.userId, userId)));
  }

  async clearBookingApprovals(bookingId: string): Promise<void> {
    await this.db.delete(bookingApprovals).where(eq(bookingApprovals.bookingId, bookingId));
  }

  async bookingApprovals(bookingId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: bookingApprovals.userId })
      .from(bookingApprovals)
      .where(eq(bookingApprovals.bookingId, bookingId))
      .orderBy(asc(bookingApprovals.createdAt));
    return rows.map((r) => r.userId);
  }

  async claimBookingReminder(id: string): Promise<boolean> {
    const rows = await this.db
      .update(bookings)
      .set({ reminderSentAt: this.now() })
      .where(and(eq(bookings.id, id), isNull(bookings.reminderSentAt)))
      .returning({ id: bookings.id });
    return rows.length > 0;
  }

  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    const [row] = await this.db.insert(events).values({ ...input, createdAt: this.now() }).returning();
    return row!;
  }

  async updateEvent(id: string, patch: EventPatch): Promise<CalendarEvent | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db
      .update(events)
      .set({ ...patch, sequence: sql`${events.sequence} + 1`, updatedAt: this.now(), ...("reminderAt" in patch ? { reminderSentAt: null } : {}) })
      .where(eq(events.id, id))
      .returning();
    return row;
  }

  async listEvents(groupId: string): Promise<CalendarEvent[]> {
    return this.db.select().from(events).where(eq(events.groupId, groupId)).orderBy(asc(events.startsAt));
  }

  async eventsForBooking(bookingId: string): Promise<CalendarEvent[]> {
    if (!UUID.test(bookingId)) return [];
    return this.db.select().from(events).where(eq(events.bookingId, bookingId));
  }

  async claimEventReminder(id: string): Promise<boolean> {
    const rows = await this.db
      .update(events)
      .set({ reminderSentAt: this.now() })
      .where(and(eq(events.id, id), isNull(events.reminderSentAt)))
      .returning({ id: events.id });
    return rows.length > 0;
  }

  async beginReply(key: string, groupId: string | null): Promise<Reply> {
    const now = this.now();
    await this.db.delete(replies).where(lt(replies.updatedAt, new Date(now.getTime() - 2 * 86_400_000)));
    const [row] = await this.db
      .insert(replies)
      .values({ key, groupId, attempts: 1, updatedAt: now })
      .onConflictDoUpdate({ target: replies.key, set: { attempts: sql`${replies.attempts} + 1`, updatedAt: now } })
      .returning();
    return row!;
  }

  async saveReply(key: string, patch: ReplyPatch): Promise<void> {
    await this.db.update(replies).set({ ...patch, updatedAt: this.now() }).where(eq(replies.key, key));
  }

  async postTripInvite(eventId: string, userId: string): Promise<Invite | undefined> {
    if (!UUID.test(eventId) || !UUID.test(userId)) return undefined;
    const [row] = await this.db
      .select()
      .from(invites)
      .where(and(eq(invites.eventId, eventId), eq(invites.issuedByUserId, userId), eq(invites.source, "post_trip")));
    return row;
  }

  async markInviteNotified(id: string): Promise<void> {
    await this.db.update(invites).set({ notifiedAt: this.now() }).where(eq(invites.id, id));
  }

  async claimEventWrap(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const rows = await this.db
      .update(events)
      .set({ wrapSentAt: this.now() })
      .where(and(eq(events.id, id), isNull(events.wrapSentAt)))
      .returning({ id: events.id });
    return rows.length > 0;
  }

  async endedTrips(since: Date, until: Date): Promise<CalendarEvent[]> {
    return this.db
      .select()
      .from(events)
      .where(and(eq(events.allDay, true), eq(events.status, "confirmed"), isNull(events.wrapSentAt), gte(events.endsAt, since), lte(events.endsAt, until)))
      .orderBy(asc(events.endsAt));
  }

  async createInvite(input: { code: string; issuedByUserId: string | null; source: InviteSource; eventId?: string | null }): Promise<Invite | undefined> {
    const [row] = await this.db
      .insert(invites)
      .values({ code: input.code, issuedByUserId: input.issuedByUserId, source: input.source, eventId: input.eventId ?? null, createdAt: this.now() })
      .onConflictDoNothing()
      .returning();
    return row;
  }

  async inviteByCode(code: string): Promise<Invite | undefined> {
    const [row] = await this.db.select().from(invites).where(eq(invites.code, code));
    return row;
  }

  async redeemInvite(code: string, userId: string): Promise<Invite | undefined> {
    const [row] = await this.db
      .update(invites)
      .set({ redeemedByUserId: userId, redeemedAt: this.now() })
      .where(and(eq(invites.code, code), isNull(invites.redeemedAt)))
      .returning();
    return row;
  }

  async setInvitesRemaining(userId: string, count: number): Promise<void> {
    await this.db.update(users).set({ invitesRemaining: count }).where(eq(users.id, userId));
  }

  async takeInvite(userId: string): Promise<boolean> {
    const rows = await this.db
      .update(users)
      .set({ invitesRemaining: sql`${users.invitesRemaining} - 1` })
      .where(and(eq(users.id, userId), gt(users.invitesRemaining, 0)))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  async unredeemedInvites(userId: string, source?: InviteSource): Promise<Invite[]> {
    return this.db
      .select()
      .from(invites)
      .where(and(eq(invites.issuedByUserId, userId), isNull(invites.redeemedAt), source ? eq(invites.source, source) : undefined))
      .orderBy(asc(invites.createdAt), asc(invites.code));
  }

  async joinWaitlist(phone: Phone): Promise<{ entry: WaitlistEntry; created: boolean }> {
    const [inserted] = await this.db.insert(waitlist).values({ phone, joinedAt: this.now() }).onConflictDoNothing().returning();
    if (inserted) return { entry: inserted, created: true };
    return { entry: (await this.waitlistEntry(phone))!, created: false };
  }

  async waitlistEntry(phone: Phone): Promise<WaitlistEntry | undefined> {
    const [row] = await this.db.select().from(waitlist).where(eq(waitlist.phone, phone));
    return row;
  }

  async leaveWaitlist(phone: Phone): Promise<void> {
    await this.db.delete(waitlist).where(eq(waitlist.phone, phone));
  }

  async nextOnWaitlist(limit: number): Promise<WaitlistEntry[]> {
    return this.db.select().from(waitlist).where(isNull(waitlist.notifiedAt)).orderBy(asc(waitlist.joinedAt), asc(waitlist.phone)).limit(limit);
  }

  async markWaitlistNotified(phone: Phone): Promise<void> {
    await this.db.update(waitlist).set({ notifiedAt: this.now() }).where(eq(waitlist.phone, phone));
  }

  async recordFailedCode(phone: Phone, windowStart: Date): Promise<number> {
    const now = this.now();
    const [row] = await this.db
      .insert(waitlist)
      .values({ phone, joinedAt: now, failedCodes: 1, failedSince: now })
      .onConflictDoUpdate({
        target: waitlist.phone,
        set: {
          failedCodes: sql`case when ${waitlist.failedSince} is null or ${waitlist.failedSince} < ${windowStart.toISOString()}::timestamptz then 1 else ${waitlist.failedCodes} + 1 end`,
          failedSince: sql`case when ${waitlist.failedSince} is null or ${waitlist.failedSince} < ${windowStart.toISOString()}::timestamptz then ${now.toISOString()}::timestamptz else ${waitlist.failedSince} end`,
        },
      })
      .returning({ failedCodes: waitlist.failedCodes });
    return row!.failedCodes;
  }

  async getEvent(id: string): Promise<CalendarEvent | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.select().from(events).where(eq(events.id, id));
    return row;
  }

  // ---- payments ----

  async setStripeAccount(userId: string, accountId: string): Promise<void> {
    await this.db.update(users).set({ stripeAccountId: accountId }).where(eq(users.id, userId));
  }

  async setStripeAccountReady(accountId: string, ready: boolean): Promise<User | undefined> {
    const [row] = await this.db.update(users).set({ stripeAccountReady: ready }).where(eq(users.stripeAccountId, accountId)).returning();
    return row;
  }

  async userByPayoutToken(token: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.payoutToken, token));
    return row;
  }

  async ensurePayoutToken(userId: string, token: string): Promise<string> {
    await this.db.update(users).set({ payoutToken: token }).where(and(eq(users.id, userId), isNull(users.payoutToken)));
    const [row] = await this.db.select({ t: users.payoutToken }).from(users).where(eq(users.id, userId));
    return row!.t!;
  }

  async createCollection(input: CreateCollectionInput) {
    const at = this.now();
    const { requests, ...fields } = input;
    return this.db.transaction(async (tx) => {
      const [collection] = await tx.insert(paymentCollections).values({ ...fields, createdAt: at, updatedAt: at }).returning();
      const rows = await tx
        .insert(paymentRequests)
        .values(requests.map((r) => ({ ...r, collectionId: collection!.id, createdAt: at, updatedAt: at })))
        .returning();
      return { collection: collection!, requests: rows };
    });
  }

  async getCollection(id: string): Promise<PaymentCollection | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.select().from(paymentCollections).where(eq(paymentCollections.id, id));
    return row;
  }

  async listCollections(groupId: string): Promise<PaymentCollection[]> {
    return this.db.select().from(paymentCollections).where(eq(paymentCollections.groupId, groupId)).orderBy(desc(paymentCollections.createdAt));
  }

  async collectionsAwaitingPayee(userId: string): Promise<PaymentCollection[]> {
    return this.db
      .select()
      .from(paymentCollections)
      .where(and(eq(paymentCollections.payeeUserId, userId), eq(paymentCollections.status, "setup")))
      .orderBy(asc(paymentCollections.createdAt));
  }

  async openCollectionsForUser(userId: string): Promise<PaymentCollection[]> {
    const paying = this.db.select({ id: paymentRequests.collectionId }).from(paymentRequests).where(eq(paymentRequests.userId, userId));
    return this.db
      .select()
      .from(paymentCollections)
      .where(
        and(
          inArray(paymentCollections.status, ["setup", "collecting"]),
          or(eq(paymentCollections.payeeUserId, userId), inArray(paymentCollections.id, paying)),
        ),
      )
      .orderBy(desc(paymentCollections.createdAt));
  }

  async updateCollection(id: string, patch: CollectionPatch): Promise<void> {
    await this.db.update(paymentCollections).set({ ...patch, updatedAt: this.now() }).where(eq(paymentCollections.id, id));
  }

  async transitionCollection(id: string, from: PaymentCollection["status"][], patch: CollectionPatch): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const rows = await this.db
      .update(paymentCollections)
      .set({ ...patch, updatedAt: this.now() })
      .where(and(eq(paymentCollections.id, id), inArray(paymentCollections.status, from)))
      .returning({ id: paymentCollections.id });
    return rows.length > 0;
  }

  async collectionByMessage(groupId: string, providerMessageId: string): Promise<PaymentCollection | undefined> {
    const [row] = await this.db
      .select()
      .from(paymentCollections)
      .where(and(eq(paymentCollections.groupId, groupId), eq(paymentCollections.messageId, providerMessageId)));
    return row;
  }

  async claimCollectionReminder(id: string): Promise<boolean> {
    const rows = await this.db
      .update(paymentCollections)
      .set({ reminderSentAt: this.now() })
      .where(and(eq(paymentCollections.id, id), isNull(paymentCollections.reminderSentAt)))
      .returning({ id: paymentCollections.id });
    return rows.length > 0;
  }

  async paymentRequests(collectionId: string): Promise<PaymentRequest[]> {
    return this.db.select().from(paymentRequests).where(eq(paymentRequests.collectionId, collectionId)).orderBy(asc(paymentRequests.createdAt), asc(paymentRequests.id));
  }

  async getPaymentRequest(id: string): Promise<PaymentRequest | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.select().from(paymentRequests).where(eq(paymentRequests.id, id));
    return row;
  }

  async paymentRequestByToken(token: string): Promise<PaymentRequest | undefined> {
    const [row] = await this.db.select().from(paymentRequests).where(eq(paymentRequests.token, token));
    return row;
  }

  async paymentRequestByIntent(intentId: string): Promise<PaymentRequest | undefined> {
    const [row] = await this.db.select().from(paymentRequests).where(eq(paymentRequests.stripePaymentIntentId, intentId));
    return row;
  }

  async transitionPaymentRequest(id: string, from: PaymentRequestStatus[], patch: PaymentRequestPatch): Promise<boolean> {
    const rows = await this.db
      .update(paymentRequests)
      .set({ ...patch, updatedAt: this.now() })
      .where(and(eq(paymentRequests.id, id), inArray(paymentRequests.status, from)))
      .returning({ id: paymentRequests.id });
    return rows.length > 0;
  }

  async setPaymentIntent(id: string, intentId: string): Promise<boolean> {
    const rows = await this.db
      .update(paymentRequests)
      .set({ stripePaymentIntentId: intentId, updatedAt: this.now() })
      .where(and(eq(paymentRequests.id, id), isNull(paymentRequests.stripePaymentIntentId)))
      .returning({ id: paymentRequests.id });
    return rows.length > 0;
  }

  async addPaymentApproval(collectionId: string, userId: string): Promise<void> {
    await this.db.insert(paymentApprovals).values({ collectionId, userId, createdAt: this.now() }).onConflictDoNothing();
  }

  async removePaymentApproval(collectionId: string, userId: string): Promise<void> {
    await this.db.delete(paymentApprovals).where(and(eq(paymentApprovals.collectionId, collectionId), eq(paymentApprovals.userId, userId)));
  }

  async paymentApprovals(collectionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: paymentApprovals.userId })
      .from(paymentApprovals)
      .where(eq(paymentApprovals.collectionId, collectionId))
      .orderBy(asc(paymentApprovals.createdAt));
    return rows.map((r) => r.userId);
  }

  // ---- the tab ----

  async createLedgerEntry(input: CreateLedgerEntryInput): Promise<LedgerEntryWithShares | undefined> {
    const { shares, ...fields } = input;
    return this.db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(ledgerEntries)
        .values({ ...fields, createdAt: this.now() })
        .onConflictDoNothing()
        .returning();
      if (!entry) return undefined;
      if (shares.length) await tx.insert(ledgerShares).values(shares.map((sh) => ({ ...sh, entryId: entry.id })));
      return { ...entry, shares: shares.map((sh) => ({ ...sh })) };
    });
  }

  async getLedgerEntry(id: string): Promise<LedgerEntryWithShares | undefined> {
    if (!UUID.test(id)) return undefined;
    const [entry] = await this.db.select().from(ledgerEntries).where(eq(ledgerEntries.id, id));
    if (!entry) return undefined;
    const shares = await this.db.select({ userId: ledgerShares.userId, amountCents: ledgerShares.amountCents }).from(ledgerShares).where(eq(ledgerShares.entryId, id));
    return { ...entry, shares };
  }

  async groupsForUser(userId: string): Promise<Group[]> {
    const rows = await this.db
      .select({ group: groups })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(eq(groupMembers.userId, userId));
    return rows.map((r) => r.group);
  }

  async listLedger(groupId: string): Promise<LedgerEntryWithShares[]> {
    const entries = await this.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.groupId, groupId), isNull(ledgerEntries.voidedAt)))
      .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.seq));
    if (!entries.length) return [];
    const shares = await this.db
      .select()
      .from(ledgerShares)
      .where(inArray(ledgerShares.entryId, entries.map((e) => e.id)));
    return entries.map((e) => ({
      ...e,
      shares: shares.filter((sh) => sh.entryId === e.id).map(({ userId, amountCents }) => ({ userId, amountCents })),
    }));
  }

  async voidLedgerEntry(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const rows = await this.db
      .update(ledgerEntries)
      .set({ voidedAt: this.now() })
      .where(and(eq(ledgerEntries.id, id), isNull(ledgerEntries.voidedAt)))
      .returning({ id: ledgerEntries.id });
    return rows.length > 0;
  }

  async createReceipt(input: { groupId: string; uploadedByUserId: string | null; imageUrl: string; parsed: ParsedReceipt }): Promise<Receipt> {
    const [row] = await this.db.insert(receipts).values({ ...input, createdAt: this.now() }).returning();
    return row!;
  }

  async getReceipt(id: string): Promise<Receipt | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.select().from(receipts).where(eq(receipts.id, id));
    return row;
  }

  async recentMedia(groupId: string, since: Date): Promise<Array<{ url: string; senderUserId: string | null; at: Date }>> {
    const rows = await this.db
      .select({ media: messages.mediaUrls, senderUserId: messages.senderUserId, at: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.groupId, groupId), eq(messages.fromNod, false), gte(messages.createdAt, since), sql`jsonb_array_length(${messages.mediaUrls}) > 0`))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(20);
    return rows.flatMap((r) => [...r.media].reverse().map((url) => ({ url, senderUserId: r.senderUserId, at: r.at })));
  }

  // ---- internals ----

  private async findMessage(provider: string, providerMessageId: string) {
    const [row] = await this.db
      .select({ id: messages.id, fromNod: messages.fromNod, reactions: messages.reactions })
      .from(messages)
      .where(and(eq(messages.provider, provider), eq(messages.providerMessageId, providerMessageId)));
    return row;
  }

  private scopeCond(scope: ChatScope): SQL {
    return "groupId" in scope
      ? eq(messages.groupId, scope.groupId)
      : and(isNull(messages.groupId), eq(messages.dmUserId, scope.dmUserId))!;
  }

  private async prune(scope: ChatScope): Promise<void> {
    const cond = this.scopeCond(scope);
    const cutoff = new Date(this.now().getTime() - this.retention.maxAgeDays * 86_400_000);
    const keep = this.db
      .select({ id: messages.id })
      .from(messages)
      .where(cond)
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(this.retention.maxMessages);
    await this.db.delete(messages).where(and(cond, or(lt(messages.createdAt, cutoff), notInArray(messages.id, keep))));
  }
}

