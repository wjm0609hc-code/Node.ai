// In-memory Store with the same behaviour as DrizzleStore (the same contract
// tests run against both). Used by the browser simulator, where there is no
// Postgres, and handy for fast tests.

import type { RecentMessage } from "../detection/addressed";
import type { Phone } from "../messaging/types";
import {
  DEFAULT_RETENTION,
  nameMatches,
  type ChatMember,
  type ChatScope,
  type Invite,
  type InviteSource,
  type Reply,
  type ReplyPatch,
  type WaitlistEntry,
  type RecentOptions,
  type Group,
  type KnownPerson,
  type CreateSearchInput,
  type Booking,
  type BookingPatch,
  type BookingStatus,
  type CollectionPatch,
  type GroupNote,
  type DatePollChoice,
  type CreateLedgerEntryInput,
  type LedgerEntryWithShares,
  type ParsedReceipt,
  type Receipt,
  type CreateCollectionInput,
  type PaymentCollection,
  type PaymentRequest,
  type PaymentRequestPatch,
  type PaymentRequestStatus,
  type CalendarEvent,
  type CreateBookingInput,
  type CreateEventInput,
  type EventPatch,
  type CreateDecisionInput,
  type CreatePendingQuestionInput,
  type Decision,
  type DecisionPatch,
  type Option,
  type PendingQuestion,
  type Search,
  type UpsertOptionInput,
  type ReactionInput,
  type RetentionPolicy,
  type SaveMessageInput,
  type Store,
  type User,
} from "./store";

interface MemMessage extends SaveMessageInput {
  id: string;
  seq: number;
  reactions: Record<string, string>;
}

let counter = 0;
const newId = () => `mem-${Date.now().toString(36)}-${(++counter).toString(36)}`;

export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private groups = new Map<string, Group>();
  private members = new Map<string, { groupId: string; userId: string; optedOut: boolean; settingsToken?: string }>();
  private messages: MemMessage[] = [];
  private contacts = new Map<string, KnownPerson & { ownerUserId: string }>();
  private options: Option[] = [];
  private searches: Search[] = [];
  private questions: PendingQuestion[] = [];
  private decisions: Decision[] = [];
  private decisionOpts: Array<{ decisionId: string; optionId: string; position: number; messageId?: string }> = [];
  private votes = new Map<string, { decisionId: string; userId: string; optionId: string }>();
  private bookings: Booking[] = [];
  private events: CalendarEvent[] = [];
  private approvals: Array<{ bookingId: string; userId: string; seq: number }> = [];
  private collections: PaymentCollection[] = [];
  private payRequests: PaymentRequest[] = [];
  private payApprovals: Array<{ collectionId: string; userId: string }> = [];
  private ledger: LedgerEntryWithShares[] = [];
  private pollChoices: DatePollChoice[] = [];
  private pollResponses = new Map<string, { decisionId: string; userId: string; positions: number[] }>();
  private receiptRows: Receipt[] = [];
  private notes: GroupNote[] = [];
  private inviteRows: Invite[] = [];
  private replyRows = new Map<string, Reply>();
  private waiting = new Map<string, WaitlistEntry>();
  private seq = 0;
  private readonly retention: RetentionPolicy;
  private readonly now: () => Date;

  constructor(opts: { retention?: RetentionPolicy; now?: () => Date } = {}) {
    this.retention = opts.retention ?? DEFAULT_RETENTION;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- users ----

  async upsertUser(phone: Phone): Promise<User> {
    for (const u of this.users.values()) if (u.phone === phone) return { ...u };
    const user: User = {
      id: newId(),
      phone,
      name: null,
      stripeCustomerId: null,
      stripeAccountId: null,
      stripeAccountReady: false,
      payoutToken: null,
      accessStatus: "waitlist",
      invitesRemaining: 0,
      setupSentAt: null,
      createdAt: this.now(),
    };
    this.users.set(user.id, user);
    return { ...user };
  }

  async getUser(id: string) {
    const u = this.users.get(id);
    return u && { ...u };
  }

  async setUserName(userId: string, name: string) {
    this.patchUser(userId, { name });
  }

  async setUserAccess(userId: string, status: User["accessStatus"]) {
    this.patchUser(userId, { accessStatus: status });
  }

  async claimSetup(userId: string) {
    const u = this.users.get(userId);
    if (!u || u.setupSentAt) return false;
    u.setupSentAt = this.now();
    return true;
  }

  // ---- groups ----

  async upsertGroup(input: { provider: string; providerGroupId: string; name?: string }) {
    const existing = await this.groupByProviderId(input.provider, input.providerGroupId);
    if (existing) {
      if (input.name && input.name !== existing.name) this.patchGroup(existing.id, { name: input.name });
      return { group: { ...this.groups.get(existing.id)! }, created: false };
    }
    const group: Group = {
      id: newId(),
      provider: input.provider,
      providerGroupId: input.providerGroupId,
      name: input.name ?? null,
      organizerUserId: null,
      addedByUserId: null,
      createdByNod: false,
      spendRules: {},
      joinedAt: null,
      introSentAt: null,
      unsupportedAt: null,
      timezone: null,
      createdAt: this.now(),
    };
    this.groups.set(group.id, group);
    return { group: { ...group }, created: true };
  }

  async getGroup(id: string) {
    const g = this.groups.get(id);
    return g && { ...g };
  }

  async groupByProviderId(provider: string, providerGroupId: string) {
    for (const g of this.groups.values()) {
      if (g.provider === provider && g.providerGroupId === providerGroupId) return { ...g };
    }
    return undefined;
  }

  async setGroupJoined(groupId: string, at: Date) {
    this.patchGroup(groupId, { joinedAt: at, unsupportedAt: null });
  }

  async setAddedBy(groupId: string, userId: string) {
    this.patchGroup(groupId, { addedByUserId: userId });
  }

  async claimIntro(groupId: string) {
    const g = this.groups.get(groupId);
    if (!g || g.introSentAt) return false;
    g.introSentAt = this.now();
    return true;
  }

  async resetIntro(groupId: string) {
    this.patchGroup(groupId, { introSentAt: null });
  }

  async markUnsupported(groupId: string) {
    this.patchGroup(groupId, { unsupportedAt: this.now() });
  }

  async markCreatedByNod(groupId: string, requesterUserId: string) {
    const at = this.now();
    this.patchGroup(groupId, { createdByNod: true, addedByUserId: requesterUserId, joinedAt: at, introSentAt: at });
  }

  async latestUnsupportedGroupFor(userId: string, since: Date) {
    const found = [...this.groups.values()]
      .filter((g) => g.addedByUserId === userId && g.unsupportedAt && g.unsupportedAt >= since)
      .sort((a, b) => b.unsupportedAt!.getTime() - a.unsupportedAt!.getTime())[0];
    return found && { ...found };
  }

  async addMembers(groupId: string, userIds: string[]) {
    for (const userId of userIds) {
      const key = `${groupId}:${userId}`;
      if (!this.members.has(key)) this.members.set(key, { groupId, userId, optedOut: false });
    }
  }

  async memberPhones(groupId: string) {
    return [...this.members.values()].filter((m) => m.groupId === groupId).map((m) => this.users.get(m.userId)!.phone);
  }

  async groupMembers(groupId: string): Promise<ChatMember[]> {
    return [...this.members.values()]
      .filter((m) => m.groupId === groupId)
      .map((m) => {
        const u = this.users.get(m.userId)!;
        return { userId: u.id, name: u.name, phone: u.phone, optedOut: m.optedOut };
      });
  }

  async setOptedOut(groupId: string, userId: string, optedOut: boolean) {
    const key = `${groupId}:${userId}`;
    this.members.set(key, { ...(this.members.get(key) ?? { groupId, userId }), optedOut });
  }

  async forgetMemberMessages(groupId: string, userId: string) {
    let n = 0;
    for (const m of this.messages) {
      if (m.groupId !== groupId || m.senderUserId !== userId) continue;
      if (m.text !== null || m.mediaUrls.length) n++;
      m.text = null;
      m.mediaUrls = [];
    }
    this.questions = this.questions.filter((q) => !(q.groupId === groupId && q.askedUserId === userId));
    return n;
  }

  async memberSettingsToken(groupId: string, userId: string, makeToken: () => string) {
    const m = this.members.get(`${groupId}:${userId}`);
    if (!m) return undefined;
    m.settingsToken ??= makeToken();
    return m.settingsToken;
  }

  async memberByToken(token: string) {
    const m = token ? [...this.members.values()].find((x) => x.settingsToken === token) : undefined;
    return m && { groupId: m.groupId, userId: m.userId };
  }

  async isOptedOut(groupId: string, userId: string) {
    return this.members.get(`${groupId}:${userId}`)?.optedOut ?? false;
  }

  // ---- people ----

  async saveContacts(ownerUserId: string, people: KnownPerson[]) {
    for (const p of people) this.contacts.set(`${ownerUserId}:${p.phone}`, { ownerUserId, name: p.name, phone: p.phone });
  }

  async findKnownPeople(ownerUserId: string, name: string) {
    const own = [...this.contacts.values()]
      .filter((c) => c.ownerUserId === ownerUserId && nameMatches(c.name, name))
      .map(({ name, phone }) => ({ name, phone }));
    if (own.length) return own;
    const myGroups = new Set([...this.members.values()].filter((m) => m.userId === ownerUserId).map((m) => m.groupId));
    const seen = new Map<string, KnownPerson>();
    for (const m of this.members.values()) {
      if (!myGroups.has(m.groupId) || m.userId === ownerUserId) continue;
      const u = this.users.get(m.userId)!;
      if (u.name && nameMatches(u.name, name)) seen.set(u.phone, { name: u.name, phone: u.phone });
    }
    return [...seen.values()];
  }

  // ---- messages ----

  async saveMessage(input: SaveMessageInput) {
    if (this.find(input.provider, input.providerMessageId)) return { saved: false, duplicate: true };
    const m: MemMessage = { ...input, mediaUrls: [...input.mediaUrls], id: newId(), seq: ++this.seq, reactions: {} };
    this.messages.push(m);
    if (input.groupId) this.prune({ groupId: input.groupId });
    else if (input.dmUserId) this.prune({ dmUserId: input.dmUserId });
    return { saved: true, duplicate: false, id: m.id };
  }

  async setMessageText(id: string, text: string) {
    const m = this.messages.find((x) => x.id === id);
    if (m) m.text = text;
  }

  async setAddressed(id: string, addressed: boolean) {
    const m = this.messages.find((x) => x.id === id);
    if (m) m.addressed = addressed;
  }

  async hasMessage(provider: string, providerMessageId: string) {
    return !!this.find(provider, providerMessageId);
  }

  async isFromNod(provider: string, providerMessageId: string) {
    return this.find(provider, providerMessageId)?.fromNod ?? false;
  }

  async recentMessages(scope: ChatScope, limit: number, opts: RecentOptions = {}): Promise<RecentMessage[]> {
    return this.inScope(scope)
      .filter((m) => m.text !== null && m.id !== opts.excludeId && m.providerMessageId !== opts.excludeProviderMessageId)
      .filter((m) => {
        if (!("groupId" in scope) || m.addressed || !m.senderUserId) return true;
        return !this.members.get(`${scope.groupId}:${m.senderUserId}`)?.optedOut;
      })
      .sort(newestFirst)
      .slice(0, limit)
      .reverse()
      .map((m) => {
        const u = m.senderUserId ? this.users.get(m.senderUserId) : undefined;
        return { from: m.fromNod ? "Nod" : (u?.name ?? u?.phone ?? "unknown"), text: m.text! };
      });
  }

  async setReaction(input: ReactionInput) {
    const m = this.find(input.provider, input.targetProviderMessageId);
    if (!m) return false;
    if (input.removed) delete m.reactions[input.userId];
    else m.reactions[input.userId] = input.reaction;
    return true;
  }

  async reactionsFor(provider: string, providerMessageId: string) {
    return { ...(this.find(provider, providerMessageId)?.reactions ?? {}) };
  }

  // ---- options ----

  async upsertOption(input: UpsertOptionInput) {
    const existing = this.options.find((o) => o.groupId === input.groupId && o.url === input.url);
    if (existing) return { option: structuredClone(existing), created: false };
    const at = this.now();
    const option: Option = { ...input, id: newId(), seq: ++this.seq, parsed: {}, createdAt: at, updatedAt: at };
    this.options.push(option);
    return { option: structuredClone(option), created: true };
  }

  async getOption(id: string) {
    const o = this.options.find((x) => x.id === id);
    return o && structuredClone(o);
  }

  async listOptions(groupId: string, filter: { kind?: Option["kind"] } = {}) {
    return this.options
      .filter((o) => o.groupId === groupId && (!filter.kind || o.kind === filter.kind))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq)
      .map((o) => structuredClone(o));
  }

  async updateOptionParsed(id: string, patch: Record<string, unknown>) {
    const o = this.options.find((x) => x.id === id);
    if (!o) return;
    o.parsed = { ...o.parsed, ...structuredClone(patch) };
    o.updatedAt = this.now();
  }

  // ---- searches ----

  async createSearch(input: CreateSearchInput) {
    const search: Search = { ...structuredClone(input), id: newId(), createdAt: this.now() };
    this.searches.push(search);
    return structuredClone(search);
  }

  async getSearch(id: string) {
    const s = this.searches.find((x) => x.id === id);
    return s && structuredClone(s);
  }

  async countSearchesSince(scope: ChatScope, since: Date) {
    return this.searches.filter(
      (s) =>
        s.createdAt >= since &&
        ("groupId" in scope ? s.groupId === scope.groupId : s.groupId === null && s.requestedByUserId === scope.dmUserId),
    ).length;
  }

  // ---- pending questions ----

  async createPendingQuestion(input: CreatePendingQuestionInput) {
    const q: PendingQuestion = { ...input, id: newId(), createdAt: this.now() };
    this.questions.push(q);
    return { ...q };
  }

  async activePendingQuestion(groupId: string, userId: string, at: Date) {
    const q = this.questions
      .filter((x) => x.groupId === groupId && x.askedUserId === userId && x.expiresAt > at && x.remaining > 0)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return q && { ...q };
  }

  async setPendingQuestionRemaining(id: string, remaining: number) {
    const q = this.questions.find((x) => x.id === id);
    if (q) q.remaining = remaining;
  }

  // ---- decisions and votes ----

  async setGroupTimezone(groupId: string, timezone: string) {
    this.patchGroup(groupId, { timezone });
  }

  async setGroupOrganizer(groupId: string, userId: string | null) {
    this.patchGroup(groupId, { organizerUserId: userId });
  }

  async createGroupNote(input: { groupId: string; subjectUserId: string | null; note: string; kind: "must_have" | "preference"; createdByUserId: string | null }) {
    const n: GroupNote = { ...input, id: newId(), seq: ++this.seq, createdAt: this.now() };
    this.notes.push(n);
    return { ...n };
  }

  async listGroupNotes(groupId: string) {
    return this.notes.filter((n) => n.groupId === groupId).map((n) => ({ ...n }));
  }

  async deleteGroupNote(id: string) {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.id !== id);
    return this.notes.length < before;
  }

  async forgetGroup(groupId: string) {
    const messages = this.messages.filter((m) => m.groupId === groupId).length;
    const notes = this.notes.filter((n) => n.groupId === groupId).length;
    this.messages = this.messages.filter((m) => m.groupId !== groupId);
    this.notes = this.notes.filter((n) => n.groupId !== groupId);
    this.questions = this.questions.filter((q) => q.groupId !== groupId);
    this.receiptRows = this.receiptRows.filter((r) => r.groupId !== groupId);
    for (const [k, r] of this.replyRows) if (r.groupId === groupId) this.replyRows.delete(k);
    return { messages, notes };
  }

  async createDecision(input: CreateDecisionInput) {
    const at = this.now();
    const { optionIds, ...fields } = input;
    const d: Decision = {
      ...fields,
      id: newId(),
      status: "open",
      winningOptionId: null,
      tieBreakUserId: null,
      nudgeSentAt: null,
      createdAt: at,
      updatedAt: at,
    };
    this.decisions.push(d);
    optionIds.forEach((optionId, i) => this.decisionOpts.push({ decisionId: d.id, optionId, position: i + 1 }));
    return { ...d };
  }

  async getDecision(id: string) {
    const d = this.decisions.find((x) => x.id === id);
    return d && { ...d };
  }

  async setDecisionOptionMessage(decisionId: string, optionId: string, providerMessageId: string) {
    const o = this.decisionOpts.find((x) => x.decisionId === decisionId && x.optionId === optionId);
    if (o) o.messageId = providerMessageId;
  }

  async decisionOptionByMessage(providerMessageId: string) {
    const o = this.decisionOpts.find((x) => x.messageId === providerMessageId);
    return o && { decisionId: o.decisionId, optionId: o.optionId, position: o.position };
  }

  async decisionOptions(decisionId: string) {
    return this.decisionOpts
      .filter((o) => o.decisionId === decisionId)
      .sort((a, b) => a.position - b.position)
      .map(({ position, optionId }) => ({ position, optionId }));
  }

  async openDecision(groupId: string) {
    const d = this.decisions
      .filter((x) => x.groupId === groupId && x.status === "open")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return d && { ...d };
  }

  async openDecisionsForUser(userId: string) {
    const mine = new Set([...this.members.values()].filter((m) => m.userId === userId).map((m) => m.groupId));
    return this.decisions
      .filter((d) => d.status === "open" && mine.has(d.groupId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((d) => ({ ...d }));
  }

  async listDecisions(groupId: string) {
    return this.decisions
      .filter((d) => d.groupId === groupId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((d) => ({ ...d }));
  }

  async updateDecision(id: string, patch: DecisionPatch) {
    const d = this.decisions.find((x) => x.id === id);
    if (d) Object.assign(d, patch, { updatedAt: this.now() });
  }

  async transitionDecision(id: string, from: Decision["status"][], patch: DecisionPatch) {
    const d = this.decisions.find((x) => x.id === id);
    if (!d || !from.includes(d.status)) return false;
    Object.assign(d, patch, { updatedAt: this.now() });
    return true;
  }

  async addDatePollChoices(decisionId: string, choices: Array<{ startsOn: string; endsOn: string | null }>) {
    choices.forEach((c, i) => this.pollChoices.push({ ...c, decisionId, position: i + 1, chosen: false, messageId: null }));
  }

  async datePollChoices(decisionId: string) {
    return this.pollChoices.filter((c) => c.decisionId === decisionId).map((c) => ({ ...c }));
  }

  async markDatePollChoice(decisionId: string, position: number) {
    const c = this.pollChoices.find((x) => x.decisionId === decisionId && x.position === position);
    if (c) c.chosen = true;
  }

  async setDatePollChoiceMessage(decisionId: string, position: number, providerMessageId: string) {
    const c = this.pollChoices.find((x) => x.decisionId === decisionId && x.position === position);
    if (c) c.messageId = providerMessageId;
  }

  async datePollChoiceByMessage(providerMessageId: string) {
    const c = this.pollChoices.find((x) => x.messageId === providerMessageId);
    return c && { ...c };
  }

  async setDatePollResponse(decisionId: string, userId: string, positions: number[]) {
    const key = `${decisionId}:${userId}`;
    this.pollResponses.delete(key); // keep answer order by last update
    this.pollResponses.set(key, { decisionId, userId, positions: [...positions] });
  }

  async datePollResponses(decisionId: string) {
    return [...this.pollResponses.values()].filter((r) => r.decisionId === decisionId).map(({ userId, positions }) => ({ userId, positions: [...positions] }));
  }

  async setVote(decisionId: string, userId: string, optionId: string) {
    this.votes.set(`${decisionId}:${userId}`, { decisionId, userId, optionId });
  }

  async removeVote(decisionId: string, userId: string, optionId: string) {
    const key = `${decisionId}:${userId}`;
    if (this.votes.get(key)?.optionId === optionId) this.votes.delete(key);
  }

  async votesFor(decisionId: string) {
    return [...this.votes.values()].filter((v) => v.decisionId === decisionId).map(({ userId, optionId }) => ({ userId, optionId }));
  }

  async optionByMessage(groupId: string, providerMessageId: string) {
    const o = this.options.find((x) => x.groupId === groupId && x.providerMessageId === providerMessageId);
    return o && structuredClone(o);
  }

  async findMessageIdByText(groupId: string, text: string) {
    return this.messages
      .filter((m) => m.groupId === groupId && m.text === text)
      .sort(newestFirst)[0]?.providerMessageId;
  }

  // ---- bookings and events ----

  async createBooking(input: CreateBookingInput) {
    const at = this.now();
    const b: Booking = {
      ...input,
      id: newId(),
      status: input.status ?? "link_sent",
      partner: input.partner ?? null,
      holderUserId: input.holderUserId ?? null,
      proposal: input.proposal ?? null,
      freeCancelUntil: input.freeCancelUntil ?? null,
      partnerBookingId: null,
      proposalMessageId: null,
      reminderSentAt: null,
      bookedByUserId: null,
      confirmation: {},
      createdAt: at,
      updatedAt: at,
    };
    this.bookings.push(b);
    return structuredClone(b);
  }

  async getBooking(id: string) {
    const b = this.bookings.find((x) => x.id === id);
    return b && structuredClone(b);
  }

  async updateBooking(id: string, patch: BookingPatch) {
    const b = this.bookings.find((x) => x.id === id);
    if (b) Object.assign(b, structuredClone(patch), { updatedAt: this.now() });
  }

  async transitionBooking(id: string, from: BookingStatus[], patch: BookingPatch) {
    const b = this.bookings.find((x) => x.id === id);
    if (!b || !from.includes(b.status)) return false;
    Object.assign(b, structuredClone(patch), { updatedAt: this.now() });
    return true;
  }

  async openProposal(groupId: string) {
    const b = this.bookings
      .filter((x) => x.groupId === groupId && x.status === "proposed")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return b && structuredClone(b);
  }

  async bookingByProposalMessage(groupId: string, providerMessageId: string) {
    const b = this.bookings.find((x) => x.groupId === groupId && x.proposalMessageId === providerMessageId);
    return b && structuredClone(b);
  }

  async addBookingApproval(bookingId: string, userId: string) {
    if (!this.approvals.some((a) => a.bookingId === bookingId && a.userId === userId)) {
      this.approvals.push({ bookingId, userId, seq: this.seq++ });
    }
  }

  async removeBookingApproval(bookingId: string, userId: string) {
    this.approvals = this.approvals.filter((a) => !(a.bookingId === bookingId && a.userId === userId));
  }

  async clearBookingApprovals(bookingId: string) {
    this.approvals = this.approvals.filter((a) => a.bookingId !== bookingId);
  }

  async bookingApprovals(bookingId: string) {
    return this.approvals.filter((a) => a.bookingId === bookingId).map((a) => a.userId);
  }

  async claimBookingReminder(id: string) {
    const b = this.bookings.find((x) => x.id === id);
    if (!b || b.reminderSentAt) return false;
    b.reminderSentAt = this.now();
    return true;
  }

  async listBookings(groupId: string) {
    return this.bookings
      .filter((b) => b.groupId === groupId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((b) => structuredClone(b));
  }

  async createEvent(input: CreateEventInput) {
    const e: CalendarEvent = {
      ...input,
      createdByUserId: input.createdByUserId ?? null,
      reminderAt: input.reminderAt ?? null,
      id: newId(),
      sequence: 0,
      status: "confirmed",
      reminderSentAt: null,
      wrapSentAt: null,
      createdAt: this.now(),
      updatedAt: null,
    };
    this.events.push(e);
    return { ...e };
  }

  async getEvent(id: string) {
    const e = this.events.find((x) => x.id === id);
    return e && { ...e };
  }

  async updateEvent(id: string, patch: EventPatch) {
    const e = this.events.find((x) => x.id === id);
    if (!e) return undefined;
    Object.assign(e, patch, { sequence: e.sequence + 1, updatedAt: this.now() }, "reminderAt" in patch ? { reminderSentAt: null } : {});
    return { ...e };
  }

  async listEvents(groupId: string) {
    return this.events.filter((e) => e.groupId === groupId).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).map((e) => ({ ...e }));
  }

  async eventsForBooking(bookingId: string) {
    return this.events.filter((e) => e.bookingId === bookingId).map((e) => ({ ...e }));
  }

  async claimEventReminder(id: string) {
    const e = this.events.find((x) => x.id === id);
    if (!e || e.reminderSentAt) return false;
    e.reminderSentAt = this.now();
    return true;
  }

  async claimEventWrap(id: string) {
    const e = this.events.find((x) => x.id === id);
    if (!e || e.wrapSentAt) return false;
    e.wrapSentAt = this.now();
    return true;
  }

  async endedTrips(since: Date, until: Date) {
    return this.events
      .filter((e) => e.allDay && e.status === "confirmed" && !e.wrapSentAt && e.endsAt >= since && e.endsAt <= until)
      .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime())
      .map((e) => ({ ...e }));
  }

  // ---- reply progress ----

  async beginReply(key: string, groupId: string | null) {
    const now = this.now();
    for (const [k, r] of this.replyRows) if (r.updatedAt.getTime() < now.getTime() - 2 * 86_400_000) this.replyRows.delete(k);
    const existing = this.replyRows.get(key);
    const row: Reply = existing
      ? { ...existing, attempts: existing.attempts + 1, updatedAt: now }
      : { key, groupId, status: "running", attempts: 1, history: [], results: {}, attachments: [], expectedFrom: null, replyText: null, sentMessageId: null, updatedAt: now };
    this.replyRows.set(key, row);
    return structuredClone(row);
  }

  async saveReply(key: string, patch: ReplyPatch) {
    const r = this.replyRows.get(key);
    if (r) Object.assign(r, structuredClone(patch), { updatedAt: this.now() });
  }

  // ---- invites ----

  async postTripInvite(eventId: string, userId: string) {
    const row = this.inviteRows.find((i) => i.eventId === eventId && i.issuedByUserId === userId && i.source === "post_trip");
    return row && { ...row };
  }

  async markInviteNotified(id: string) {
    const row = this.inviteRows.find((i) => i.id === id);
    if (row) row.notifiedAt = this.now();
  }

  async createInvite(input: { code: string; issuedByUserId: string | null; source: InviteSource; eventId?: string | null }) {
    if (this.inviteRows.some((i) => i.code === input.code)) return undefined;
    const row: Invite = {
      id: newId(),
      code: input.code,
      issuedByUserId: input.issuedByUserId,
      redeemedByUserId: null,
      source: input.source,
      eventId: input.eventId ?? null,
      createdAt: this.now(),
      redeemedAt: null,
      notifiedAt: null,
    };
    this.inviteRows.push(row);
    return { ...row };
  }

  async inviteByCode(code: string) {
    const row = this.inviteRows.find((i) => i.code === code);
    return row && { ...row };
  }

  async redeemInvite(code: string, userId: string) {
    const row = this.inviteRows.find((i) => i.code === code);
    if (!row || row.redeemedAt) return undefined;
    Object.assign(row, { redeemedByUserId: userId, redeemedAt: this.now() });
    return { ...row };
  }

  async setInvitesRemaining(userId: string, count: number) {
    const u = this.users.get(userId);
    if (u) u.invitesRemaining = count;
  }

  async takeInvite(userId: string) {
    const u = this.users.get(userId);
    if (!u || u.invitesRemaining <= 0) return false;
    u.invitesRemaining -= 1;
    return true;
  }

  async unredeemedInvites(userId: string, source?: InviteSource) {
    return this.inviteRows.filter((i) => i.issuedByUserId === userId && !i.redeemedAt && (!source || i.source === source)).map((i) => ({ ...i }));
  }

  async joinWaitlist(phone: Phone) {
    const existing = this.waiting.get(phone);
    if (existing) return { entry: { ...existing }, created: false };
    const entry: WaitlistEntry = { phone, joinedAt: this.now(), notifiedAt: null, failedCodes: 0, failedSince: null };
    this.waiting.set(phone, entry);
    return { entry: { ...entry }, created: true };
  }

  async waitlistEntry(phone: Phone) {
    const e = this.waiting.get(phone);
    return e && { ...e };
  }

  async leaveWaitlist(phone: Phone) {
    this.waiting.delete(phone);
  }

  async nextOnWaitlist(limit: number) {
    return [...this.waiting.values()]
      .filter((e) => !e.notifiedAt)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.phone.localeCompare(b.phone))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async markWaitlistNotified(phone: Phone) {
    const e = this.waiting.get(phone);
    if (e) e.notifiedAt = this.now();
  }

  async recordFailedCode(phone: Phone, windowStart: Date) {
    const { entry } = await this.joinWaitlist(phone);
    const e = this.waiting.get(entry.phone)!;
    if (!e.failedSince || e.failedSince < windowStart) Object.assign(e, { failedCodes: 1, failedSince: this.now() });
    else e.failedCodes += 1;
    return e.failedCodes;
  }

  // ---- payments ----

  async setStripeAccount(userId: string, accountId: string) {
    this.patchUser(userId, { stripeAccountId: accountId });
  }

  async setStripeAccountReady(accountId: string, ready: boolean) {
    const u = [...this.users.values()].find((x) => x.stripeAccountId === accountId);
    if (!u) return undefined;
    u.stripeAccountReady = ready;
    return { ...u };
  }

  async userByPayoutToken(token: string) {
    const u = [...this.users.values()].find((x) => x.payoutToken === token);
    return u && { ...u };
  }

  async ensurePayoutToken(userId: string, token: string) {
    const u = this.users.get(userId)!;
    if (!u.payoutToken) u.payoutToken = token;
    return u.payoutToken;
  }

  async createCollection(input: CreateCollectionInput) {
    const at = this.now();
    const { requests, ...fields } = input;
    const collection: PaymentCollection = {
      ...structuredClone(fields),
      purpose: fields.purpose ?? "request",
      id: newId(),
      messageId: null,
      reminderSentAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const rows: PaymentRequest[] = requests.map((r) => ({
      ...r,
      id: newId(),
      collectionId: collection.id,
      stripePaymentIntentId: null,
      attempt: 0,
      status: "pending",
      createdAt: at,
      updatedAt: at,
    }));
    this.collections.push(collection);
    this.payRequests.push(...rows);
    return structuredClone({ collection, requests: rows });
  }

  async getCollection(id: string) {
    const c = this.collections.find((x) => x.id === id);
    return c && structuredClone(c);
  }

  async listCollections(groupId: string) {
    return structuredClone(this.collections.filter((c) => c.groupId === groupId).reverse());
  }

  async collectionsAwaitingPayee(userId: string) {
    return structuredClone(this.collections.filter((c) => c.payeeUserId === userId && c.status === "setup"));
  }

  async openCollectionsForUser(userId: string) {
    const paying = new Set(this.payRequests.filter((r) => r.userId === userId).map((r) => r.collectionId));
    return structuredClone(
      this.collections.filter((c) => (c.status === "setup" || c.status === "collecting") && (c.payeeUserId === userId || paying.has(c.id))).reverse(),
    );
  }

  async updateCollection(id: string, patch: CollectionPatch) {
    const c = this.collections.find((x) => x.id === id);
    if (c) Object.assign(c, structuredClone(patch), { updatedAt: this.now() });
  }

  async transitionCollection(id: string, from: PaymentCollection["status"][], patch: CollectionPatch) {
    const c = this.collections.find((x) => x.id === id);
    if (!c || !from.includes(c.status)) return false;
    Object.assign(c, structuredClone(patch), { updatedAt: this.now() });
    return true;
  }

  async collectionByMessage(groupId: string, providerMessageId: string) {
    const c = this.collections.find((x) => x.groupId === groupId && x.messageId === providerMessageId);
    return c && structuredClone(c);
  }

  async claimCollectionReminder(id: string) {
    const c = this.collections.find((x) => x.id === id);
    if (!c || c.reminderSentAt) return false;
    c.reminderSentAt = this.now();
    return true;
  }

  async paymentRequests(collectionId: string) {
    return structuredClone(this.payRequests.filter((r) => r.collectionId === collectionId));
  }

  async getPaymentRequest(id: string) {
    const r = this.payRequests.find((x) => x.id === id);
    return r && structuredClone(r);
  }

  async paymentRequestByToken(token: string) {
    const r = this.payRequests.find((x) => x.token === token);
    return r && structuredClone(r);
  }

  async paymentRequestByIntent(intentId: string) {
    const r = this.payRequests.find((x) => x.stripePaymentIntentId === intentId);
    return r && structuredClone(r);
  }

  async transitionPaymentRequest(id: string, from: PaymentRequestStatus[], patch: PaymentRequestPatch) {
    const r = this.payRequests.find((x) => x.id === id);
    if (!r || !from.includes(r.status)) return false;
    Object.assign(r, structuredClone(patch), { updatedAt: this.now() });
    return true;
  }

  async setPaymentIntent(id: string, intentId: string) {
    const r = this.payRequests.find((x) => x.id === id);
    if (!r || r.stripePaymentIntentId) return false;
    r.stripePaymentIntentId = intentId;
    r.updatedAt = this.now();
    return true;
  }

  async addPaymentApproval(collectionId: string, userId: string) {
    if (!this.payApprovals.some((a) => a.collectionId === collectionId && a.userId === userId)) this.payApprovals.push({ collectionId, userId });
  }

  async removePaymentApproval(collectionId: string, userId: string) {
    this.payApprovals = this.payApprovals.filter((a) => !(a.collectionId === collectionId && a.userId === userId));
  }

  async paymentApprovals(collectionId: string) {
    return this.payApprovals.filter((a) => a.collectionId === collectionId).map((a) => a.userId);
  }

  // ---- the tab ----

  async createLedgerEntry(input: CreateLedgerEntryInput) {
    if (input.sourceId && this.ledger.some((e) => e.groupId === input.groupId && e.source === input.source && e.sourceId === input.sourceId)) {
      return undefined;
    }
    const entry: LedgerEntryWithShares = { ...structuredClone(input), id: newId(), seq: ++this.seq, voidedAt: null, createdAt: this.now() };
    this.ledger.push(entry);
    return structuredClone(entry);
  }

  async getLedgerEntry(id: string) {
    const e = this.ledger.find((x) => x.id === id);
    return e && structuredClone(e);
  }

  async groupsForUser(userId: string) {
    const ids = new Set([...this.members.values()].filter((m) => m.userId === userId).map((m) => m.groupId));
    return [...this.groups.values()].filter((g) => ids.has(g.id)).map((g) => ({ ...g }));
  }

  async listLedger(groupId: string) {
    return structuredClone(this.ledger.filter((e) => e.groupId === groupId && !e.voidedAt));
  }

  async voidLedgerEntry(id: string) {
    const e = this.ledger.find((x) => x.id === id);
    if (!e || e.voidedAt) return false;
    e.voidedAt = this.now();
    return true;
  }

  async createReceipt(input: { groupId: string; uploadedByUserId: string | null; imageUrl: string; parsed: ParsedReceipt }) {
    const r: Receipt = { ...structuredClone(input), id: newId(), createdAt: this.now() };
    this.receiptRows.push(r);
    return structuredClone(r);
  }

  async getReceipt(id: string) {
    const r = this.receiptRows.find((x) => x.id === id);
    return r && structuredClone(r);
  }

  async recentMedia(groupId: string, since: Date) {
    return this.messages
      .filter((m) => m.groupId === groupId && !m.fromNod && m.createdAt >= since && m.mediaUrls.length)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.seq - a.seq)
      .flatMap((m) => [...m.mediaUrls].reverse().map((url) => ({ url, senderUserId: m.senderUserId, at: m.createdAt })));
  }

  // ---- internals ----

  private find(provider: string, providerMessageId: string) {
    return this.messages.find((m) => m.provider === provider && m.providerMessageId === providerMessageId);
  }

  private inScope(scope: ChatScope) {
    return this.messages.filter((m) =>
      "groupId" in scope ? m.groupId === scope.groupId : m.groupId === null && m.dmUserId === scope.dmUserId,
    );
  }

  private prune(scope: ChatScope) {
    const cutoff = this.now().getTime() - this.retention.maxAgeDays * 86_400_000;
    const keep = new Set(this.inScope(scope).sort(newestFirst).slice(0, this.retention.maxMessages).map((m) => m.id));
    const doomed = new Set(this.inScope(scope).filter((m) => !keep.has(m.id) || m.createdAt.getTime() < cutoff).map((m) => m.id));
    if (doomed.size) this.messages = this.messages.filter((m) => !doomed.has(m.id));
  }

  private patchUser(id: string, patch: Partial<User>) {
    const u = this.users.get(id);
    if (u) Object.assign(u, patch);
  }

  private patchGroup(id: string, patch: Partial<Group>) {
    const g = this.groups.get(id);
    if (g) Object.assign(g, patch);
  }
}

function newestFirst(a: MemMessage, b: MemMessage) {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.seq - a.seq;
}
