// Claude orchestration: context → Claude with tools → tool calls → one reply.
//
// A manual loop rather than the SDK tool runner: each tool call needs Nod's own
// chat context (caller, members, chat) for permission checks, the request uses
// server-side refusal fallbacks (beta), and a fake client keeps it testable.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Store } from "../db/store";
import type { AddressedCall } from "../inbound/pipeline";
import type { Logger } from "../lib/log";
import type { Destination, MessagingProvider } from "../messaging/types";
import { buildContext, SYSTEM_PROMPT, type ContextSection } from "./context";
import { createToolRegistry, type NodTool, type ToolContext } from "./tools";

export type AgentClient = Pick<Anthropic, "beta">;

export const SNAG_MESSAGE = "Sorry, I couldn't do that just now. Try again in a minute.";

export interface ResponderDeps {
  store: Store;
  provider: MessagingProvider;
  logger: Logger;
  client?: AgentClient;
  /** Defaults to NOD_MODEL or claude-opus-5-5. */
  model?: string;
  /** Defaults to NOD_EFFORT or medium. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  tools?: NodTool<any>[];
  sections?: ContextSection[];
  /** Claude calls per message, tool rounds included. */
  maxTurns?: number;
  maxReplyChars?: number;
  timeoutMs?: number;
  now?: () => Date;
}

// Models that accept output_config.effort and server-side refusal fallbacks.
const CURRENT_GEN = /^claude-(?:opus-5|fable-5|sonnet-5-5)/;

export function createResponder(deps: ResponderDeps) {
  const { store, provider, logger } = deps;
  const model = deps.model ?? process.env.NOD_MODEL ?? "claude-opus-5-5";
  const effort = deps.effort ?? (process.env.NOD_EFFORT as ResponderDeps["effort"]) ?? "medium";
  const current = CURRENT_GEN.test(model);
  const registry = createToolRegistry(deps.tools ?? []);
  const maxTurns = deps.maxTurns ?? 6;
  let client = deps.client;

  return async function respond(call: AddressedCall): Promise<void> {
    client ??= new Anthropic();
    const ctx = await buildContext(call, { store, selfPhone: provider.selfPhone, sections: deps.sections, now: deps.now });
    const attachments = new Set<string>();
    const toolCtx: ToolContext = {
      store,
      provider,
      logger,
      chat: ctx.chat,
      caller: ctx.caller,
      members: ctx.members,
      attach: (url) => attachments.add(url),
    };
    const to: Destination = ctx.chat.kind === "group" ? { groupId: ctx.chat.providerGroupId } : { phone: call.event.from };
    const messages: BetaMessageParam[] = [{ role: "user", content: ctx.userText }];
    const tools = registry.definitions();

    for (let turn = 0; turn < maxTurns; turn++) {
      let response: { stop_reason: string | null; content: BetaContentBlock[] };
      try {
        response = await client.beta.messages.create(
          {
            model,
            max_tokens: 16000,
            system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages,
            ...(tools.length ? { tools } : {}),
            ...(current ? { output_config: { effort }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { timeout: deps.timeoutMs ?? 60_000, maxRetries: 2 },
        );
      } catch (err) {
        logger.error("agent.claude_failed", { messageId: call.event.messageId, error: (err as Error).name });
        await provider.send(to, { text: SNAG_MESSAGE });
        return;
      }

      if (response.stop_reason === "refusal") {
        logger.warn("agent.refused", { messageId: call.event.messageId });
        return;
      }
      if (response.stop_reason === "tool_use" || response.stop_reason === "pause_turn") {
        // Append the assistant turn exactly as returned (thinking blocks included).
        messages.push({ role: "assistant", content: response.content });
        const uses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
        if (!uses.length) continue; // pause_turn: let Claude carry on
        const results = await Promise.all(uses.map((u) => registry.run(u.name, u.input, toolCtx)));
        logger.info("agent.tools_ran", { messageId: call.event.messageId, tools: uses.map((u) => u.name) });
        const toolResults: BetaToolResultBlockParam[] = uses.map((u, i) => ({
          type: "tool_result",
          tool_use_id: u.id,
          content: results[i]!.content,
          is_error: results[i]!.isError,
        }));
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      const reply = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      logger.info("agent.replied", { messageId: call.event.messageId, turns: turn + 1, silent: !reply });
      if (reply) {
        await provider.send(to, {
          text: shorten(reply, deps.maxReplyChars ?? 700),
          ...(attachments.size === 1 ? { mediaUrls: [...attachments] } : {}),
        });
      }
      return;
    }

    logger.warn("agent.too_many_turns", { messageId: call.event.messageId, maxTurns });
    await provider.send(to, { text: SNAG_MESSAGE });
  };
}

/** Rule 2: short replies. Cuts at a word boundary and marks the cut. */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
