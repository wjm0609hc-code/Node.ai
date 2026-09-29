// Persistence for users, groups, members and recent messages. Enforces the
// privacy rules from CLAUDE.md: keep at most the last 200 messages or 30 days
// per chat (whichever is smaller), and skip opted-out members' messages.

import { and, desc, eq, isNull, lt, not, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Phone, Service, Tapback } from "../messaging/types";
import type { RecentMessage } from "../detection/addressed";
import type { Db } from "./client";
import { groupMembers, groups, messages, users, type Group, type User } from "./schema";

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

export class MessageStore {
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

  async setUserName(userId: string, name: string): Promise<void> {
    await this.db.update(users).set({ name }).where(eq(users.id, userId));
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

  async setGroupJoined(groupId: string, at: Date): Promise<void> {
    await this.db.update(groups).set({ joinedAt: at }).where(eq(groups.id, groupId));
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
  async setReaction(input: {
    provider: string;
    targetProviderMessageId: string;
    userId: string;
    reaction: Tapback;
    removed: boolean;
  }): Promise<boolean> {
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

