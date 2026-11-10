// Follow-up answers (CLAUDE.md, "Calling Nod"): after Nod replies, some messages count as
// meant for Nod without @Nod: an answer from a member Nod asked by name (expect_answer_from),
// the first answer to a question Nod asked the whole group (expect_answer_from_group), and the
// caller's own follow-ups to their request (opened automatically after every group reply).

import { displayName } from "../context";
import { defineTool, ToolError } from "../tools";
import { resolveMember } from "./members";

/** How long, and for how many of their messages, an answer counts without @Nod. */
export const FOLLOWUP_MINUTES = 10;
export const FOLLOWUP_MESSAGES = 2;
/** After a reply that asks nothing, the caller can still follow up ("actually make it 8pm") for this long. */
export const CALLER_FOLLOWUP_MINUTES = 3;
/** A question to the whole group: how many messages, from anyone, are checked before the window closes. */
export const GROUP_FOLLOWUP_MESSAGES = 8;
/** After the group answers, how many changes to that answer ("actually make it 7") Nod acts on, within the same 10 minutes. */
export const GROUP_UPDATES = 2;

export const expectAnswerFrom = defineTool<{ member: string }>({
  name: "expect_answer_from",
  description:
    "Call this when your reply asks a specific group member other than the person who called you a question only they can answer " +
    "(a price, a date, how much someone owes). The person who called you can already reply without tagging you. " +
    `For ${FOLLOWUP_MINUTES} minutes, their next message counts as an answer to you without them tagging you. ` +
    "Address them by name in your reply. Don't use it for questions to the whole group.",
  inputSchema: {
    type: "object",
    properties: { member: { type: "string", description: "The member's name exactly as it appears in the member list." } },
    required: ["member"],
    additionalProperties: false,
  },
  async run({ member }, ctx) {
    if (ctx.chat.kind !== "group") throw new ToolError("Private chats don't need this. Anything they send here reaches you.");
    const m = resolveMember(ctx, member);
    ctx.expectAnswer?.(m.userId);
    return `${displayName(m)} can answer your question without tagging you for the next ${FOLLOWUP_MINUTES} minutes.`;
  },
});

export const expectAnswerFromGroup = defineTool<Record<string, never>>({
  name: "expect_answer_from_group",
  description:
    "Call this when your reply asks the whole group one short question that anyone can answer (how many people, which neighborhood, what time). " +
    `For ${FOLLOWUP_MINUTES} minutes, the first message from anyone that answers it reaches you without them tagging you, and so do up to ${GROUP_UPDATES} clear changes to that answer ("actually make it 7"). ` +
    "Ask only when you can't pick a sensible default. For a choice between options or dates, run start_vote or run_date_poll instead, so people tap.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(_input, ctx) {
    if (ctx.chat.kind !== "group") throw new ToolError("Private chats don't need this. Anything they send here reaches you.");
    ctx.expectGroupAnswer?.();
    return `Anyone in the group can answer your question without tagging you for the next ${FOLLOWUP_MINUTES} minutes. Ask it plainly in your reply, to everyone.`;
  },
});
