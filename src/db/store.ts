// Persistence for users, groups, members and recent messages. Enforces the
// privacy rules from CLAUDE.md: keep at most the last 200 messages or 30 days
// per chat (whichever is smaller), and skip opted-out members' messages.

import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, not, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Phone, Service, Tapback } from "../messaging/types";
import type { RecentMessage } from "../detection/addressed";
import type { Db } from "./client";
import { groupMembers, groups, messages, userContacts, users, type Group, type User } from "./schema";

export type { Group, User } from "./schema";

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
  recentMessages(scope: ChatScope, limit: number, opts?: { excludeId?: string }): Promise<RecentMessage[]>;
  setReaction(input: ReactionInput): Promise<boolean>;
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
  async recentMessages(scope: ChatScope, limit: number, opts: { excludeId?: string } = {}): Promise<RecentMessage[]> {
    const conds: SQL[] = [this.scopeCond(scope), not(isNull(messages.text))];
    if (opts.excludeId) conds.push(not(eq(messages.id, opts.excludeId)));
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

