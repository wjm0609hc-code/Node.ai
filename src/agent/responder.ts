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
import type { Destination, MessagingProvider, Service } from "../messaging/types";
import { buildContext, SYSTEM_PROMPT, type ContextSection } from "./context";
import { createToolRegistry, type ChatInfo, type NodTool, type ToolContext } from "./tools";
import { FOLLOWUP_MESSAGES, FOLLOWUP_MINUTES } from "./tools/expect-answer";
import { cardContent, linkFor, type CardLink, type Cards } from "../cards/cards";

/** Saved with the reply's attachments so a retry still sends the cards. */
const CARD_PREFIX = "card:";

export type AgentClient = Pick<Anthropic, "beta">;

export const SNAG_MESSAGE = "Sorry, I hit a snag on my end. Try me again in a minute.";

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
  /** Default timezone for chats without their own. */
  timezone?: string;
  /** Claude calls per message, tool rounds included. */
  maxTurns?: number;
  maxReplyChars?: number;
  timeoutMs?: number;
  now?: () => Date;
  /** Product cards; tools attach them and they're sent after the reply text. */
  cards?: Cards;
  appUrl?: string;
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

  /**
   * Answers one call. Progress is saved as it goes (see `replies` in the schema), so when a
   * reply job is retried it resumes: finished tool calls are never run again, and a reply that
   * was already sent isn't sent twice. Errors are thrown for the job to retry; on the final
   * attempt (`final`, the default outside jobs) Nod apologises instead.
   */
  return async function respond(call: AddressedCall, opts: RespondOptions = {}): Promise<void> {
    const final = opts.final ?? true;
    const key = replyKey(call);
    const state = await store.beginReply(key, call.groupId);
    if (state.status === "done") return;
    client ??= new Anthropic();
    const ctx = await buildContext(call, { store, selfPhone: provider.selfPhone, sections: deps.sections, now: deps.now, defaultTimezone: deps.timezone });
    const to: Destination = ctx.chat.kind === "group" ? { groupId: ctx.chat.providerGroupId } : { phone: call.event.from };
    const done = () => store.saveReply(key, { status: "done", history: [], results: {} });
    const attachments = new Set<string>(state.attachments.filter((a) => !a.startsWith(CARD_PREFIX)));
    const cardIds = state.attachments.filter((a) => a.startsWith(CARD_PREFIX)).map((a) => a.slice(CARD_PREFIX.length));
    const cardKeys = new Map<string, string>();
    let expectedFrom: string | undefined = state.expectedFrom ?? undefined;
    const saved = () => [...attachments, ...cardIds.map((id) => CARD_PREFIX + id)];
    const service = (ctx.chat.kind === "group" ? ((await store.getGroup(ctx.chat.groupId))?.service ?? call.event.service) : call.event.service) as Service;

    const deliver = async (text: string) => {
      if (state.status !== "sending") {
        await store.saveReply(key, { status: "sending", replyText: text, attachments: saved() });
        state.status = "sending";
      }
      if (text && !state.sentMessageId) {
        const sent = await provider.send(to, { text, ...(attachments.size === 1 ? { mediaUrls: [...attachments] } : {}) });
        state.sentMessageId = sent.messageId || "sent";
        await store.saveReply(key, { sentMessageId: state.sentMessageId });
      }
      // Then each card, in order; sent ones are dropped from the saved list so a retry doesn't repeat them.
      while (cardIds.length) {
        await provider.send(to, cardContent(linkFor(deps.appUrl, cardIds[0]!, ""), service));
        cardIds.shift();
        await store.saveReply(key, { attachments: saved() });
      }
      if (text && state.sentMessageId) {
        await openFollowup({ store, chat: ctx.chat, askedUserId: expectedFrom, callerUserId: call.senderUserId, messageId: state.sentMessageId === "sent" ? "" : state.sentMessageId, question: text, now: deps.now });
      }
      await done();
    };
    const snag = async () => {
      await provider.send(to, { text: SNAG_MESSAGE });
      await done();
    };

    // A reply chosen before a crash or failed send: just send it.
    if (state.status === "sending") return deliver(state.replyText ?? "");

    const toolCtx: ToolContext = {
      store,
      provider,
      logger,
      chat: ctx.chat,
      caller: ctx.caller,
      members: ctx.members,
      mediaUrls: call.event.mediaUrls,
      attach: (url) => attachments.add(url),
      ...(deps.cards ? { cards: deps.cards } : {}),
      attachCard: (card: CardLink, k?: string) => {
        const at = k ? cardKeys.get(k) : undefined;
        const i = at ? cardIds.indexOf(at) : -1;
        if (i >= 0) cardIds[i] = card.id;
        else if (!cardIds.includes(card.id)) cardIds.push(card.id);
        if (k) cardKeys.set(k, card.id);
      },
      expectAnswer: (userId) => {
        expectedFrom = userId;
      },
    };
    // Resume the saved conversation, or start one from the context as it is now (and save it, so a retry sees the same context).
    const messages = (state.history.length ? state.history : [{ role: "user", content: ctx.userText }]) as BetaMessageParam[];
    if (!state.history.length) await store.saveReply(key, { history: messages });
    const results = { ...state.results };
    const tools = registry.definitions();

    for (let turn = messages.filter((m) => m.role === "assistant").length; turn < maxTurns; turn++) {
      const last = messages[messages.length - 1]!;
      let response: { stop_reason: string | null; content: BetaContentBlock[] };
      if (last.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => (b as { type: string }).type === "tool_use")) {
        // Crashed while running this round's tools: finish them below without asking Claude again.
        response = { stop_reason: "tool_use", content: last.content as BetaContentBlock[] };
        messages.pop();
      } else {
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
          logger.error("agent.claude_failed", { messageId: call.event.messageId, error: (err as Error).name, final });
          if (!final) throw err;
          return snag();
        }
      }

      if (response.stop_reason === "refusal") {
        logger.warn("agent.refused", { messageId: call.event.messageId });
        return done();
      }
      if (response.stop_reason === "tool_use" || response.stop_reason === "pause_turn") {
        // Append the assistant turn exactly as returned (thinking blocks included).
        messages.push({ role: "assistant", content: response.content });
        await store.saveReply(key, { history: messages });
        const uses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
        if (!uses.length) continue; // pause_turn: let Claude carry on
        await Promise.all(
          uses.map(async (u) => {
            if (results[u.id]) return; // ran before a retry
            results[u.id] = await registry.run(u.name, u.input, toolCtx);
            await store.saveReply(key, { results, attachments: saved(), expectedFrom: expectedFrom ?? null });
          }),
        );
        logger.info("agent.tools_ran", { messageId: call.event.messageId, tools: uses.map((u) => u.name) });
        const toolResults: BetaToolResultBlockParam[] = uses.map((u) => ({
          type: "tool_result",
          tool_use_id: u.id,
          content: results[u.id]!.content,
          is_error: results[u.id]!.isError,
        }));
        messages.push({ role: "user", content: toolResults });
        for (const k of Object.keys(results)) delete results[k];
        await store.saveReply(key, { history: messages, results: {} });
        continue;
      }

      const reply = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      logger.info("agent.replied", { messageId: call.event.messageId, turns: turn + 1, silent: !reply });
      if (!reply && !cardIds.length) return done();
      return deliver(reply ? shorten(reply, deps.maxReplyChars ?? 700) : "");
    }

    logger.warn("agent.too_many_turns", { messageId: call.event.messageId, maxTurns });
    return snag();
  };
}

export interface RespondOptions {
  /** False while a job can still retry: errors are thrown instead of apologising. Defaults to true. */
  final?: boolean;
}

/** One reply per inbound message. */
export function replyKey(call: Pick<AddressedCall, "event">): string {
  return `${call.event.provider}:${call.event.messageId}`;
}

/** True when a reply asks something (a "?" outside any link). */
export function asksQuestion(text: string): boolean {
  return text.replace(/https?:\/\/\S+/gi, "").includes("?");
}

/**
 * After a reply that asks someone something, lets their next message answer without @Nod.
 * The member Claude named with expect_answer_from, else the person who called Nod when the reply asks a question.
 */
export async function openFollowup(args: {
  store: Store;
  chat: ChatInfo;
  askedUserId: string | undefined;
  callerUserId: string;
  messageId: string;
  question: string;
  now?: () => Date;
}): Promise<void> {
  const askedUserId = args.askedUserId ?? (asksQuestion(args.question) ? args.callerUserId : undefined);
  if (!askedUserId || args.chat.kind !== "group" || !args.messageId) return;
  const now = (args.now ?? (() => new Date()))();
  await args.store.createPendingQuestion({
    groupId: args.chat.groupId,
    askedUserId,
    nodProviderMessageId: args.messageId,
    question: args.question,
    remaining: FOLLOWUP_MESSAGES,
    expiresAt: new Date(now.getTime() + FOLLOWUP_MINUTES * 60_000),
  });
}

/** Rule 2: short replies. Cuts at a word boundary and marks the cut. */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
