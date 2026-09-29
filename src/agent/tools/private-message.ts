// Rule 3, "nudge privately": anything about one person's money goes to that person directly.

import { displayName } from "../context";
import { defineTool, ToolError } from "../tools";
import { resolveMember } from "./members";

export const sendPrivateMessage = defineTool<{ to: string; text: string }>({
  name: "send_private_message",
  description:
    "Send a private 1:1 message to one member of the current group chat. Use it for anything about that person's own money " +
    "(what they owe, a payment reminder) or anything else that shouldn't go to the whole group. " +
    "Only reaches members of this group. After using it, tell the group briefly (without the private details) or say nothing.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "The member's name exactly as it appears in the member list." },
      text: { type: "string", minLength: 1, description: "The private message: one or two short sentences, plain text." },
    },
    required: ["to", "text"],
    additionalProperties: false,
  },
  async run({ to, text }, ctx) {
    if (ctx.chat.kind !== "group") throw new ToolError("Private messages can only be sent from a group chat. Just reply here.");
    const member = resolveMember(ctx, to);
    await ctx.provider.send({ phone: member.phone }, { text });
    ctx.logger.info("agent.private_message_sent", { groupId: ctx.chat.groupId });
    return `Sent privately to ${displayName(member)}.`;
  },
});
