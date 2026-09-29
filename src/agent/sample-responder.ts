// The same orchestration as responder.ts, but through a claude.ai Artifact's
// `sample` capability instead of the Anthropic API: the web simulator runs in
// a browser with no API key, and Claude answers on the viewer's own account.
// Context, system prompt and tools are shared with the production responder.

import type { Store } from "../db/store";
import type { Classifier } from "../detection/addressed";
import type { AddressedCall } from "../inbound/pipeline";
import type { Logger } from "../lib/log";
import type { Destination, MessagingProvider } from "../messaging/types";
import { buildContext, SYSTEM_PROMPT, type ContextSection } from "./context";
import { shorten, SNAG_MESSAGE } from "./responder";
import { createToolRegistry, type NodTool, type ToolContext } from "./tools";

/** The part of the Artifact `sample` capability Nod uses. */
export interface SampleFn {
  (input: string, opts?: { cache?: false; tools?: SampleTool[]; modelTier?: "quick" | "default" | "complex" }): Promise<{
    text: string;
    truncated: boolean;
  }>;
  json(input: string, opts?: { cache?: false; modelTier?: "quick" | "default" | "complex" }): Promise<unknown>;
}

interface SampleTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, context: unknown): Promise<string>;
}

/** Claude writes this when a message turns out not to need a reply (sample can't return empty text). */
export const NO_REPLY = "NO_REPLY";

const SAMPLE_NOTES = `Notes for this setting: if you use a tool, call it before writing anything, then write only your reply to the chat. If no reply is needed, write exactly ${NO_REPLY} and nothing else.`;

/** Codes that mean Claude can't be used in this view at all. */
const UNAVAILABLE = new Set([
  "not_granted",
  "sampling_disabled",
  "not_declared",
  "capability_disabled",
  "capability_removed",
  "tools_unavailable",
  "session_expired",
]);

export interface SampleResponderDeps {
  store: Store;
  provider: MessagingProvider;
  logger: Logger;
  sample: SampleFn;
  tools?: NodTool<any>[];
  sections?: ContextSection[];
  maxReplyChars?: number;
  /** Called when this viewer can't use Claude (declined, disabled, signed out). */
  onUnavailable?: (code: string) => void;
  now?: () => Date;
}

export function createSampleResponder(deps: SampleResponderDeps) {
  const { store, provider, logger } = deps;
  const registry = createToolRegistry(deps.tools ?? []);
  const definitions = registry.definitions();

  return async function respond(call: AddressedCall): Promise<void> {
    const ctx = await buildContext(call, { store, selfPhone: provider.selfPhone, sections: deps.sections, now: deps.now });
    const toolCtx: ToolContext = { store, provider, logger, chat: ctx.chat, caller: ctx.caller, members: ctx.members };
    const to: Destination = ctx.chat.kind === "group" ? { groupId: ctx.chat.providerGroupId } : { phone: call.event.from };
    const tools: SampleTool[] = definitions.map((d) => ({
      name: d.name,
      description: d.description ?? "",
      inputSchema: d.input_schema as Record<string, unknown>,
      async execute(input) {
        const result = await registry.run(d.name, input, toolCtx);
        if (result.isError) throw new Error(result.content);
        return result.content;
      },
    }));

    let text: string;
    try {
      ({ text } = await deps.sample(`${SYSTEM_PROMPT}\n\n${SAMPLE_NOTES}\n\n${ctx.userText}`, {
        cache: false,
        ...(tools.length ? { tools } : {}),
      }));
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "upstream_error";
      if (code === "empty_completion" || code === "refused" || code === "cancelled") return;
      if (UNAVAILABLE.has(code)) {
        logger.warn("agent.sample_unavailable", { code });
        deps.onUnavailable?.(code);
        return;
      }
      logger.error("agent.sample_failed", { code });
      await provider.send(to, { text: SNAG_MESSAGE });
      return;
    }

    const reply = text.trim();
    if (!reply || reply === NO_REPLY) return;
    await provider.send(to, { text: shorten(reply, deps.maxReplyChars ?? 700) });
  };
}

/** The ambiguous-"nod" check through `sample.json` on the quick tier. Errors propagate: the caller stays silent. */
export function createSampleClassifier(sample: SampleFn): Classifier {
  return async ({ text, recent }) => {
    const context = recent.length ? recent.map((m) => `${m.from}: ${m.text}`).join("\n") : "(none)";
    const answer = await sample.json(
      `An AI assistant named Nod sits in a group chat. "nod" is also an ordinary English word ("gave me the nod", "nod off").
Is this message addressed to the assistant named Nod? Reply with only {"addressed": true} or {"addressed": false}.

Recent messages, oldest first:
${context}

Message to classify:
${text}`,
      { modelTier: "quick", cache: false },
    );
    return (answer as { addressed?: unknown })?.addressed === true;
  };
}
