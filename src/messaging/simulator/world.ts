// In-memory model of iMessage/SMS group chats with fake people, for local
// development and tests. `ChatWorld` is the "phone network"; `provider()`
// returns Nod's view of it as a MessagingProvider.
//
// Fidelity rules this models (see CLAUDE.md, "Getting Nod into a group"):
// - Nod only receives events for groups it is currently in, and never sees
//   messages sent before it joined (or while it was removed).
// - A group containing any Android phone is an SMS/MMS group: no tapbacks
//   (they arrive as text like `Liked “…”`), no inline replies, no mentions.
// - People can add Nod only to an all-iMessage group of 3+ people. Nod can
//   create groups itself, including mixed iPhone/Android ones.

import { MessagingError, type ContactCard, type InboundEvent, type Phone, type Service, type Tapback } from "../types";
import { SimulatorProvider } from "./provider";

export const NOD_PHONE: Phone = "+15550100000";
export const NOD_NAME = "Nod";

export type Platform = "iphone" | "android";

export interface SimUser {
  id: string;
  name: string;
  phone: Phone;
  platform: Platform;
}

/** "nod" stands for Nod itself anywhere a participant is expected. */
export type Participant = string | "nod";

export interface TranscriptLine {
  messageId: string;
  kind: "message" | "reaction" | "system";
  from: Participant | null;
  fromName: string;
  text: string;
  mediaUrls: string[];
  contactCard?: ContactCard;
  /** Contact cards a person shared. */
  contactCards?: ContactCard[];
  replyToMessageId?: string;
  reaction?: { target: string; tapback: Tapback; removed: boolean };
  /** Who could see this line when it was posted. */
  visibleTo: Set<Participant>;
  sentAt: Date;
}

interface SimGroup {
  id: string;
  name?: string;
  members: Set<Participant>;
  createdByNod: boolean;
  lines: TranscriptLine[];
}

export type AddNodResult =
  | { ok: true }
  | { ok: false; reason: "group_too_small" | "not_all_imessage" | "not_a_member" | "already_member" };

export interface SayOptions {
  replyTo?: string;
  /** A real iMessage mention of Nod's contact (picked from autocomplete). */
  mentionNod?: boolean;
  mediaUrls?: string[];
  contactCards?: ContactCard[];
}

const TAPBACK_VERBS: Record<Tapback, [string, string]> = {
  love: ["Loved", "a heart"],
  like: ["Liked", "a like"],
  dislike: ["Disliked", "a dislike"],
  laugh: ["Laughed at", "a laugh"],
  emphasize: ["Emphasized", "an exclamation"],
  question: ["Questioned", "a question mark"],
};

export class ChatWorld {
  private users = new Map<string, SimUser>();
  private groups = new Map<string, SimGroup>();
  private dms = new Map<string, TranscriptLine[]>();
  private seq = 0;
  private pending: Promise<void>[] = [];
  private nodProvider: SimulatorProvider;
  readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.nodProvider = new SimulatorProvider(this);
  }

  /** Nod's side of the world. */
  provider(): SimulatorProvider {
    return this.nodProvider;
  }

  // ---- people and groups ---------------------------------------------------

  addUser(input: { name: string; platform: Platform; phone?: Phone }): SimUser {
    const n = this.users.size + 1;
    const user: SimUser = {
      id: `u${n}`,
      name: input.name,
      platform: input.platform,
      phone: input.phone ?? `+1555020${String(n).padStart(4, "0")}`,
    };
    if (this.userByPhone(user.phone) || user.phone === NOD_PHONE) throw new Error(`phone ${user.phone} already in use`);
    this.users.set(user.id, user);
    return user;
  }

  user(id: string): SimUser {
    const u = this.users.get(id);
    if (!u) throw new Error(`unknown user ${id}`);
    return u;
  }

  userByPhone(phone: Phone): SimUser | undefined {
    for (const u of this.users.values()) if (u.phone === phone) return u;
    return undefined;
  }

  allUsers(): SimUser[] {
    return [...this.users.values()];
  }

  allGroups(): Array<{ id: string; name?: string; members: Participant[]; service: Service; hasNod: boolean }> {
    return [...this.groups.values()].map((g) => ({
      id: g.id,
      name: g.name,
      members: [...g.members],
      service: this.groupService(g.id),
      hasNod: g.members.has("nod"),
    }));
  }

  /** A group started by people (Nod not in it). */
  createGroup(input: { name?: string; createdBy: string; members: string[] }): string {
    const members = new Set(input.members);
    members.add(input.createdBy);
    for (const m of members) this.user(m);
    if (members.size < 2) throw new Error("a group needs at least two people");
    const id = `g${this.groups.size + 1}`;
    this.groups.set(id, { id, name: input.name, members, createdByNod: false, lines: [] });
    return id;
  }

  groupService(groupId: string): Service {
    const g = this.group(groupId);
    for (const m of g.members) if (m !== "nod" && this.user(m).platform === "android") return "sms";
    return "imessage";
  }

  hasNod(groupId: string): boolean {
    return this.group(groupId).members.has("nod");
  }

  // ---- things people do ----------------------------------------------------

  say(userId: string, groupId: string, text: string, opts: SayOptions = {}): string {
    const g = this.group(groupId);
    if (!g.members.has(userId)) throw new Error(`${userId} is not in ${groupId}`);
    const sms = this.groupService(groupId) === "sms";
    const line = this.post(g, {
      kind: "message",
      from: userId,
      text,
      mediaUrls: opts.mediaUrls ?? [],
      contactCards: opts.contactCards,
      replyToMessageId: sms ? undefined : opts.replyTo,
    });
    this.deliver(g, {
      type: "message",
      provider: "simulator",
      messageId: line.messageId,
      groupId,
      from: this.user(userId).phone,
      text,
      mediaUrls: line.mediaUrls,
      service: sms ? "sms" : "imessage",
      replyToMessageId: line.replyToMessageId,
      mentions: !sms && opts.mentionNod ? [NOD_PHONE] : [],
      ...(opts.contactCards?.length ? { contactCards: opts.contactCards } : {}),
      sentAt: line.sentAt,
    });
    return line.messageId;
  }

  react(userId: string, targetMessageId: string, tapback: Tapback, opts: { removed?: boolean } = {}): string {
    const { group: g, line: target } = this.findLine(targetMessageId);
    if (!g.members.has(userId)) throw new Error(`${userId} is not in ${g.id}`);
    const removed = opts.removed ?? false;

    if (this.groupService(g.id) === "sms") {
      // SMS has no tapbacks: the phone sends a text describing the reaction instead.
      const [verb, noun] = TAPBACK_VERBS[tapback];
      const text = removed ? `Removed ${noun} from “${target.text}”` : `${verb} “${target.text}”`;
      return this.say(userId, g.id, text);
    }

    const line = this.post(g, {
      kind: "reaction",
      from: userId,
      text: `${this.user(userId).name} ${removed ? "removed" : "reacted"} ${tapback} to “${target.text}”`,
      mediaUrls: [],
      reaction: { target: targetMessageId, tapback, removed },
    });
    this.deliver(g, {
      type: "reaction",
      provider: "simulator",
      groupId: g.id,
      from: this.user(userId).phone,
      targetMessageId,
      reaction: tapback,
      removed,
      sentAt: line.sentAt,
    });
    return line.messageId;
  }

  /** A private message from a person to Nod. */
  dm(userId: string, text: string, opts: { mediaUrls?: string[]; contactCards?: ContactCard[] } = {}): string {
    const user = this.user(userId);
    const line = this.makeLine(
      { kind: "message", from: userId, text, mediaUrls: opts.mediaUrls ?? [], contactCards: opts.contactCards },
      [userId, "nod"],
    );
    this.dmThread(userId).push(line);
    this.emit({
      type: "message",
      provider: "simulator",
      messageId: line.messageId,
      groupId: null,
      from: user.phone,
      text,
      mediaUrls: line.mediaUrls,
      service: user.platform === "iphone" ? "imessage" : "sms",
      mentions: [],
      ...(opts.contactCards?.length ? { contactCards: opts.contactCards } : {}),
      sentAt: line.sentAt,
    });
    return line.messageId;
  }

  /** A member adds Nod's contact to the group (group name → Add Contact → "Nod"). */
  addNod(groupId: string, byUserId: string): AddNodResult {
    const g = this.group(groupId);
    if (g.members.has("nod")) return { ok: false, reason: "already_member" };
    if (!g.members.has(byUserId)) return { ok: false, reason: "not_a_member" };
    if (this.groupService(groupId) !== "imessage") return { ok: false, reason: "not_all_imessage" };
    if (g.members.size < 3) return { ok: false, reason: "group_too_small" };

    g.members.add("nod");
    const line = this.post(g, {
      kind: "system",
      from: byUserId,
      text: `${this.user(byUserId).name} added ${NOD_NAME} to the conversation.`,
      mediaUrls: [],
    });
    this.emit({
      type: "participant_added",
      provider: "simulator",
      groupId,
      addedBy: this.user(byUserId).phone,
      added: [NOD_PHONE],
      members: this.memberPhones(g),
      groupName: g.name,
      service: "imessage",
      sentAt: line.sentAt,
    });
    return { ok: true };
  }

  removeNod(groupId: string, byUserId: string): void {
    const g = this.group(groupId);
    if (!g.members.has("nod")) throw new Error(`Nod is not in ${groupId}`);
    if (!g.members.has(byUserId)) throw new Error(`${byUserId} is not in ${groupId}`);
    const line = this.post(g, {
      kind: "system",
      from: byUserId,
      text: `${this.user(byUserId).name} removed ${NOD_NAME} from the conversation.`,
      mediaUrls: [],
    });
    g.members.delete("nod");
    this.emit({
      type: "participant_removed",
      provider: "simulator",
      groupId,
      removedBy: this.user(byUserId).phone,
      removed: [NOD_PHONE],
      sentAt: line.sentAt,
    });
  }

  // ---- views ---------------------------------------------------------------

  /** What `viewer` sees in the group: only lines posted while they were a member. */
  transcript(groupId: string, viewer: Participant): TranscriptLine[] {
    const lines = this.group(groupId).lines;
    return lines
      .filter((l) => l.visibleTo.has(viewer))
      .map((l) => {
        if (!l.reaction) return l;
        const target = lines.find((t) => t.messageId === l.reaction!.target);
        if (target?.visibleTo.has(viewer)) return l;
        return { ...l, text: `${l.fromName} ${l.reaction.removed ? "removed" : "reacted"} ${l.reaction.tapback} to an earlier message` };
      });
  }

  dmTranscript(userId: string): TranscriptLine[] {
    return [...this.dmThread(userId)];
  }

  /** Wait for every inbound handler triggered so far. Rethrows the first handler error. */
  async settled(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      await Promise.all(batch);
    }
  }

  // ---- used by SimulatorProvider -------------------------------------------

  /** @internal */
  nodSendToGroup(
    groupId: string,
    content: { text: string; mediaUrls: string[]; contactCard?: ContactCard; replyToMessageId?: string },
  ): TranscriptLine {
    const g = this.groups.get(groupId);
    if (!g) throw new MessagingError(`unknown group ${groupId}`, "unknown_group");
    if (!g.members.has("nod")) throw new MessagingError(`Nod is not in ${groupId}`, "not_in_group");
    const sms = this.groupService(groupId) === "sms";
    return this.post(g, {
      kind: "message",
      from: "nod",
      text: content.text,
      mediaUrls: content.mediaUrls,
      contactCard: content.contactCard,
      replyToMessageId: sms ? undefined : content.replyToMessageId,
    });
  }

  /** @internal */
  nodSendToPhone(phone: Phone, content: { text: string; mediaUrls: string[]; contactCard?: ContactCard }): TranscriptLine {
    const user = this.userByPhone(phone);
    if (!user) throw new MessagingError(`no phone ${phone} in the simulator`, "unknown_recipient");
    const line = this.makeLine({ kind: "message", from: "nod", ...content }, [user.id, "nod"]);
    this.dmThread(user.id).push(line);
    return line;
  }

  /** @internal */
  nodCreateGroup(phones: Phone[], name?: string): string {
    const ids = phones.map((p) => {
      const u = this.userByPhone(p);
      if (!u) throw new MessagingError(`no phone ${p} in the simulator`, "unknown_recipient");
      return u.id;
    });
    const members = new Set<Participant>(ids);
    if (members.size < 2) throw new MessagingError("a group needs at least two other people", "too_few_members");
    members.add("nod");
    const id = `g${this.groups.size + 1}`;
    this.groups.set(id, { id, name, members, createdByNod: true, lines: [] });
    return id;
  }

  // ---- internals -----------------------------------------------------------

  private group(id: string): SimGroup {
    const g = this.groups.get(id);
    if (!g) throw new Error(`unknown group ${id}`);
    return g;
  }

  private dmThread(userId: string): TranscriptLine[] {
    let t = this.dms.get(userId);
    if (!t) this.dms.set(userId, (t = []));
    return t;
  }

  private findLine(messageId: string): { group: SimGroup; line: TranscriptLine } {
    for (const group of this.groups.values()) {
      const line = group.lines.find((l) => l.messageId === messageId);
      if (line) return { group, line };
    }
    throw new Error(`unknown message ${messageId}`);
  }

  private memberPhones(g: SimGroup): Phone[] {
    return [...g.members].map((m) => (m === "nod" ? NOD_PHONE : this.user(m).phone));
  }

  private makeLine(
    fields: Omit<TranscriptLine, "messageId" | "fromName" | "visibleTo" | "sentAt">,
    visibleTo: Iterable<Participant>,
  ): TranscriptLine {
    return {
      ...fields,
      messageId: `m${++this.seq}`,
      fromName: fields.from === "nod" ? NOD_NAME : fields.from ? this.user(fields.from).name : "",
      visibleTo: new Set(visibleTo),
      sentAt: this.now(),
    };
  }

  private post(g: SimGroup, fields: Omit<TranscriptLine, "messageId" | "fromName" | "visibleTo" | "sentAt">): TranscriptLine {
    const line = this.makeLine(fields, g.members);
    g.lines.push(line);
    return line;
  }

  /** Emit to Nod only if Nod is in the group. */
  private deliver(g: SimGroup, event: InboundEvent): void {
    if (g.members.has("nod")) this.emit(event);
  }

  private emit(event: InboundEvent): void {
    const p = this.nodProvider.dispatch(event);
    p.catch(() => {}); // reported by settled(), not as an unhandled rejection
    this.pending.push(p);
  }
}
