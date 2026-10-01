// Group notes and "forget this chat" (Phase 1 step 15), plus naming the
// group's organizer (what's left of step 14).
//
// Notes come in two kinds, and the difference matters:
//   - must_have: allergies, dietary rules, accessibility. Nod makes sure there's
//     something that works for that person, but never drops a place over it.
//   - preference: likes and dislikes ("Sarah doesn't love steak"). Context only.
//     A preference never excludes anything; at most Nod mentions it when useful.
// Nod saves a note only when someone asks it to, never from overheard chat.

import type { ContextSection } from "../agent/context";
import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool, type ToolContext } from "../agent/tools";
import { resolveMember } from "../agent/tools/members";
import type { ChatMember, Group, Store } from "../db/store";
import type { Logger } from "../lib/log";

export interface NotesDeps {
  store: Store;
  logger: Logger;
}

const MAX_NOTES = 40;

/** Who can name a new organizer: the current one; if none, whoever added Nod; if neither is still here, anyone. */
export function canSetOrganizer(group: Pick<Group, "organizerUserId" | "addedByUserId">, memberIds: string[], callerId: string): boolean {
  const holder = [group.organizerUserId, group.addedByUserId].find((id): id is string => !!id && memberIds.includes(id));
  return !holder || holder === callerId;
}

export function createNotes(deps: NotesDeps) {
  const { store, logger } = deps;

  async function groupOf(ctx: ToolContext): Promise<Group> {
    if (ctx.chat.kind !== "group") throw new ToolError("That's for the group chat.");
    return (await store.getGroup(ctx.chat.groupId))!;
  }

  const nameIn = (members: ChatMember[], id: string | null) => {
    const m = members.find((x) => x.userId === id);
    return m ? displayName(m) : null;
  };

  const rememberNote = defineTool<{ note: string; about?: string; kind: "must_have" | "preference" }>({
    name: "remember_group_note",
    description:
      "Save something the group asks you to remember ('remember Mike's vegetarian', 'Sarah doesn't love steak', 'we're on a budget'). " +
      "Only when someone asks you to remember it; never save things you overheard. kind: must_have for allergies, dietary rules " +
      "(vegetarian, kosher, gluten-free) and accessibility needs; preference for likes and dislikes. about: the member's name, or " +
      "leave it out for the whole group. Confirm in a few words.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "Short, e.g. 'vegetarian', 'doesn't love steak'." },
        about: { type: "string" },
        kind: { type: "string", enum: ["must_have", "preference"] },
      },
      required: ["note", "kind"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const group = await groupOf(ctx);
      const note = input.note.trim().slice(0, 120);
      if (!note) throw new ToolError("What should I remember?");
      const subject = input.about ? resolveMember(ctx, input.about) : null;
      const existing = await store.listGroupNotes(group.id);
      if (existing.length >= MAX_NOTES) throw new ToolError(`This group already has ${MAX_NOTES} notes. Remove some first.`);
      const dup = existing.find((n) => n.subjectUserId === (subject?.userId ?? null) && n.note.toLowerCase() === note.toLowerCase());
      if (dup) return `Already saved: ${subject ? `${displayName(subject)}: ` : ""}${note}.`;
      const saved = await store.createGroupNote({ groupId: group.id, subjectUserId: subject?.userId ?? null, note, kind: input.kind, createdByUserId: ctx.caller.userId });
      logger.info("notes.saved", { noteId: saved.id, kind: input.kind });
      return `Saved${subject ? ` for ${displayName(subject)}` : ""}: ${note} (${input.kind === "must_have" ? "must-have" : "preference"}).`;
    },
  });

  const forgetNote = defineTool<{ note_id: string }>({
    name: "forget_group_note",
    description: "Delete one saved note when someone asks (anyone in the group can). Then confirm in a few words.",
    inputSchema: { type: "object", properties: { note_id: { type: "string" } }, required: ["note_id"], additionalProperties: false },
    async run({ note_id }, ctx) {
      const group = await groupOf(ctx);
      const note = (await store.listGroupNotes(group.id)).find((n) => n.id === note_id);
      if (!note) throw new ToolError("That note isn't saved for this group.");
      await store.deleteGroupNote(note.id);
      return `Deleted “${note.note}”.`;
    },
  });

  const forgetChat = defineTool<Record<string, never>>({
    name: "forget_chat",
    description:
      "Delete everything Nod has stored from this chat's conversation: messages, saved notes, receipt photos and open questions, when " +
      "someone says '@Nod forget this chat'. Anyone in the group can. The tab, bookings and payments stay so nobody loses track of " +
      "money. Confirm in one short line, saying what was kept.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_input, ctx) {
      const group = await groupOf(ctx);
      const { messages, notes } = await store.forgetGroup(group.id);
      logger.info("notes.forgot_chat", { groupId: group.id, messages, notes });
      return `Deleted ${messages} stored message${messages === 1 ? "" : "s"} and ${notes} note${notes === 1 ? "" : "s"}. The tab, bookings and payments are kept.`;
    },
  });

  const setOrganizer = defineTool<{ member: string }>({
    name: "set_organizer",
    description:
      "Make someone the group's organizer, when asked ('@Nod make Sarah the organizer'). The organizer approves spending under the " +
      "group's rules. Only the current organizer can hand it over (if none is set, whoever added Nod). Confirm in a few words.",
    inputSchema: { type: "object", properties: { member: { type: "string" } }, required: ["member"], additionalProperties: false },
    async run({ member }, ctx) {
      const group = await groupOf(ctx);
      const target = resolveMember(ctx, member);
      const memberIds = ctx.members.map((m) => m.userId);
      if (!canSetOrganizer(group, memberIds, ctx.caller.userId)) {
        const holder = nameIn(ctx.members, group.organizerUserId) ?? nameIn(ctx.members, group.addedByUserId) ?? "the organizer";
        throw new ToolError(`Only ${holder} can hand over the organizer role.`);
      }
      await store.setGroupOrganizer(group.id, target.userId);
      logger.info("notes.organizer_set", { groupId: group.id });
      return `${displayName(target)} is now the organizer and approves the group's spending.`;
    },
  });

  const section: ContextSection = async (call) => {
    if (!call.groupId) return null;
    const [group, members, notes] = await Promise.all([store.getGroup(call.groupId), store.groupMembers(call.groupId), store.listGroupNotes(call.groupId)]);
    const organizer = nameIn(members, group?.organizerUserId ?? null);
    const adder = nameIn(members, group?.addedByUserId ?? null);
    const lines = [
      organizer
        ? `Organizer (approves spending): ${organizer}.`
        : `No organizer set; ${adder ?? "the person asking"} approves spending by default. set_organizer changes it.`,
    ];
    const line = (n: (typeof notes)[number]) => `[note ${n.id}] ${nameIn(members, n.subjectUserId) ?? "Group"}: ${n.note}`;
    const must = notes.filter((n) => n.kind === "must_have");
    const prefs = notes.filter((n) => n.kind === "preference");
    if (must.length) lines.push("Must-haves (make sure there's an option that works for them; never drop a place over these):", ...must.map(line));
    if (prefs.length) lines.push("Preferences (context only; never exclude anything because of these, at most mention them when useful):", ...prefs.map(line));
    return { title: "group", body: lines.join("\n") };
  };

  const tools: NodTool<any>[] = [rememberNote, forgetNote, forgetChat, setOrganizer];
  return { tools, section };
}
