// Follow-up answers (CLAUDE.md, "Calling Nod"): when Nod's reply asks one member
// a question, their next message can answer it without tagging Nod.

import { displayName } from "../context";
import { defineTool, ToolError } from "../tools";
import { resolveMember } from "./members";

/** How long, and for how many of their messages, an answer counts without @Nod. */
export const FOLLOWUP_MINUTES = 10;
export const FOLLOWUP_MESSAGES = 2;

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
