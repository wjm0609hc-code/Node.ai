// Persistence for users, groups, members and recent messages. Enforces the
// privacy rules from CLAUDE.md: keep at most the last 200 messages or 30 days
// per chat (whichever is smaller), and skip opted-out members' messages.

import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, not, notInArray, or, sql, type SQL } from "drizzle-orm";
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
  type Decision,
  type Group,
  type Option,
  type PendingQuestion,
  type Search,
  type User,
} from "./schema";

export type { Decision, Group, Option, PendingQuestion, Search, User } from "./schema";

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
  setVote(decisionId: string, userId: string, optionId: string): Promise<void>;
  /** Removes this person's vote only if it's for `optionId` (e.g. they removed that tapback). */
  removeVote(decisionId: string, userId: string, optionId: string): Promise<void>;
  votesFor(decisionId: string): Promise<Array<{ userId: string; optionId: string }>>;
  /** The option first posted in this message (tapback votes). */
  optionByMessage(groupId: string, providerMessageId: string): Promise<Option | undefined>;
  /** Newest stored message in the group with exactly this text (SMS tapback text quotes it). */
  findMessageIdByText(groupId: string, text: string): Promise<string | undefined>;
  reactionsFor(provider: string, providerMessageId: string): Promise<Record<string, string>>;
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

  async createDecision(input: CreateDecisionInput): Promise<Decision> {
    const at = this.now();
    const { optionIds, ...fields } = input;
    const [row] = await this.db.insert(decisions).values({ ...fields, createdAt: at, updatedAt: at }).returning();
    await this.db.insert(decisionOptions).values(optionIds.map((optionId, i) => ({ decisionId: row!.id, optionId, position: i + 1 })));
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

