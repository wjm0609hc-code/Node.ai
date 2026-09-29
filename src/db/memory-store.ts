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
  type RecentOptions,
  type Group,
  type KnownPerson,
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
  private members = new Map<string, { groupId: string; userId: string; optedOut: boolean }>();
  private messages: MemMessage[] = [];
  private contacts = new Map<string, KnownPerson & { ownerUserId: string }>();
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
    this.members.set(`${groupId}:${userId}`, { groupId, userId, optedOut });
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
