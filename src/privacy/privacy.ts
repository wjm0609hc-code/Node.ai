// Rule 7, the per-person parts: any member can stop Nod reading their messages
// ("@Nod don't read my messages"), and each member has a private settings page per
// group (/group/[id]/settings?t=…) showing what Nod keeps, with the same switch and
// a way to delete saved notes.
//
// Opting out clears that person's stored messages in the group. Nod still answers
// when they tag it, and they can still vote and pay (the pipeline already handles
// opted-out members this way).

import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool } from "../agent/tools";
import { readSpendRules } from "../booking/approvals";
import type { ChatMember, Group, Store } from "../db/store";
import type { Logger } from "../lib/log";
import type { MessagingProvider } from "../messaging/types";
import { randomToken } from "../payments/payments";
import { renderSettingsPage, settingsNotFoundPage, type SettingsView } from "./page";

export interface PrivacyDeps {
  store: Store;
  logger: Logger;
  appUrl?: string;
  newToken?: () => string;
}

export type SettingsAction = "opt_out" | "opt_in" | "delete_note";
export interface PageResult {
  status: number;
  html: string;
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function createPrivacy(deps: PrivacyDeps) {
  const { store, logger } = deps;
  const newToken = deps.newToken ?? randomToken;

  /** Stops (or restarts) Nod reading one member's messages in one group. Returns how many stored messages were cleared. */
  async function setReading(groupId: string, userId: string, read: boolean): Promise<number> {
    await store.setOptedOut(groupId, userId, !read);
    const cleared = read ? 0 : await store.forgetMemberMessages(groupId, userId);
    logger.info(read ? "privacy.opted_in" : "privacy.opted_out", { groupId, cleared });
    return cleared;
  }

  /** Groups this person is in that Nod is currently part of. */
  async function activeGroups(userId: string): Promise<Group[]> {
    return (await store.groupsForUser(userId)).filter((g) => g.introSentAt);
  }

  async function linkFor(groupId: string, userId: string): Promise<string | undefined> {
    const token = await store.memberSettingsToken(groupId, userId, newToken);
    if (!token) return undefined;
    return `${deps.appUrl ?? ""}/group/${groupId}/settings?t=${encodeURIComponent(token)}`;
  }

  const setMessageReading = defineTool<{ read: boolean }>({
    name: "set_message_reading",
    description:
      "When a member asks you to stop reading their messages ('@Nod don't read my messages', 'opt me out') or to start again. " +
      "read: false stops it and deletes their stored messages; true turns reading back on. Only ever for the caller, never for someone else. " +
      "In a group it applies to that group; in a private chat, to every group they share with Nod. They can still tag you, vote and pay. " +
      "Confirm in one short line.",
    inputSchema: { type: "object", properties: { read: { type: "boolean" } }, required: ["read"], additionalProperties: false },
    async run({ read }, ctx) {
      const groups = ctx.chat.kind === "group" ? [{ id: ctx.chat.groupId, name: ctx.chat.name ?? null }] : await activeGroups(ctx.caller.userId);
      if (!groups.length) throw new ToolError("They aren't in any group chats with Nod.");
      let cleared = 0;
      for (const g of groups) cleared += await setReading(g.id, ctx.caller.userId, read);
      const where = ctx.chat.kind === "group" ? "this chat" : groups.length === 1 ? (groups[0]!.name ?? "their group") : `all ${groups.length} of their groups`;
      return read
        ? `Nod reads ${ctx.caller.name}'s messages in ${where} again.`
        : `Nod no longer reads ${ctx.caller.name}'s messages in ${where}, and deleted ${cleared} stored message${cleared === 1 ? "" : "s"}. They can still tag Nod, vote and pay.`;
    },
  });

  const settingsLink = defineTool<Record<string, never>>({
    name: "settings_link",
    description:
      "Send the caller their private settings page for the group (what Nod keeps, stopping Nod reading their messages, deleting saved " +
      "notes) when they ask for settings or privacy controls. The link goes privately. In a group, say it's sent; in a private chat, reply with nothing.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_input, ctx) {
      const groups = ctx.chat.kind === "group" ? [{ id: ctx.chat.groupId, name: ctx.chat.name ?? null }] : (await activeGroups(ctx.caller.userId)).slice(0, 5);
      if (!groups.length) throw new ToolError("They aren't in any group chats with Nod, so there are no settings yet.");
      const lines: string[] = [];
      for (const g of groups) {
        const link = await linkFor(g.id, ctx.caller.userId);
        if (link) lines.push(groups.length === 1 ? link : `${g.name ?? "Group"}: ${link}`);
      }
      if (!lines.length) throw new ToolError("Couldn't make a settings link.");
      const text = groups.length === 1 ? `Your Nod settings for ${groups[0]!.name ?? "the group"} (just for you): ${lines[0]}` : `Your Nod settings (just for you):\n${lines.join("\n")}`;
      await ctx.provider.send({ phone: ctx.caller.phone }, { text });
      return ctx.chat.kind === "group" ? `Sent ${ctx.caller.name} their settings link privately.` : "Sent. Reply with nothing.";
    },
  });

  async function viewer(groupId: string, token: string | null) {
    if (!token) return undefined;
    const member = await store.memberByToken(token);
    if (!member || member.groupId !== groupId) return undefined;
    const group = await store.getGroup(groupId);
    return group ? { group, userId: member.userId, token } : undefined;
  }

  async function view(groupId: string, token: string, flash?: string): Promise<SettingsView | undefined> {
    const v = await viewer(groupId, token);
    if (!v) return undefined;
    const [members, notes, optedOut] = await Promise.all([store.groupMembers(groupId), store.listGroupNotes(groupId), store.isOptedOut(groupId, v.userId)]);
    const nameOf = (id: string | null) => {
      const m = members.find((x: ChatMember) => x.userId === id);
      return m ? displayName(m) : null;
    };
    const organizer = nameOf(v.group.organizerUserId);
    const fallback = nameOf(v.group.addedByUserId) ?? "whoever asks";
    const rules = readSpendRules(v.group.spendRules);
    return {
      groupId,
      token,
      groupName: v.group.name,
      viewerName: nameOf(v.userId) ?? "you",
      optedOut,
      approverLine: organizer ? `${organizer} is the organizer and approves spending.` : `No organizer set, so ${fallback} approves spending.`,
      limitLine: `Over ${money(rules.perPersonLimitCents)} per person needs ${rules.approvalsOverLimit} approvals.`,
      notes: notes.map((n) => ({ id: n.id, about: nameOf(n.subjectUserId) ?? "Group", note: n.note, kind: n.kind as "must_have" | "preference" })),
      flash,
    };
  }

  async function settingsPage(groupId: string, token: string | null, flash?: string): Promise<PageResult> {
    const v = token ? await view(groupId, token, flash) : undefined;
    return v ? { status: 200, html: renderSettingsPage(v) } : { status: 404, html: settingsNotFoundPage() };
  }

  async function settingsAction(groupId: string, token: string | null, action: string | null, noteId: string | null): Promise<PageResult> {
    const v = await viewer(groupId, token);
    if (!v) return { status: 404, html: settingsNotFoundPage() };
    let flash: string;
    if (action === "opt_out") {
      const cleared = await setReading(groupId, v.userId, false);
      flash = `Done. Nod won't read your messages here, and deleted ${cleared} stored message${cleared === 1 ? "" : "s"}.`;
    } else if (action === "opt_in") {
      await setReading(groupId, v.userId, true);
      flash = "Done. Nod reads your messages here again.";
    } else if (action === "delete_note" && noteId) {
      const note = (await store.listGroupNotes(groupId)).find((n) => n.id === noteId);
      if (note) await store.deleteGroupNote(note.id); // anyone in the group can delete a note
      flash = note ? `Deleted “${note.note}”.` : "That note was already deleted.";
    } else {
      return { status: 400, html: settingsNotFoundPage() };
    }
    return settingsPage(groupId, v.token, flash);
  }

  const tools: NodTool<any>[] = [setMessageReading, settingsLink];
  return { tools, setReading, linkFor, settingsPage, settingsAction };
}

export type Privacy = ReturnType<typeof createPrivacy>;
