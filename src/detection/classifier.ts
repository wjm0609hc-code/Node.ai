// The Claude call for ambiguous mentions of "nod". Fails closed: anything
// other than a clear structured yes means Nod stays silent.

import Anthropic from "@anthropic-ai/sdk";
import type { Classifier, RecentMessage } from "./addressed";

export type ClassifierClient = Pick<Anthropic, "beta">;

export interface ClaudeClassifierOptions {
  client?: ClassifierClient;
  /** Defaults to NOD_CLASSIFIER_MODEL or claude-opus-5-5. */
  model?: string;
  timeoutMs?: number;
}

const SYSTEM = `You decide whether a group-chat message is talking to an AI assistant named Nod, who sits in the chat.
"nod" is also an ordinary English word ("gave me the nod", "nod along", "nod off"), so only answer true when the sender is speaking to, asking, or instructing the assistant.
Is this message addressed to the assistant named Nod? Answer yes or no.`;

// Models that accept `output_config.effort` and server-side refusal fallbacks.
const CURRENT_GEN = /^claude-(?:opus-5|fable-5|sonnet-5-5)/;

export function createClaudeClassifier(opts: ClaudeClassifierOptions = {}): Classifier {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? process.env.NOD_CLASSIFIER_MODEL ?? "claude-opus-5-5";
  const timeout = opts.timeoutMs ?? 5000;
  const current = CURRENT_GEN.test(model);

  return async ({ text, recent }) => {
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 256,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt(text, recent) }],
        output_config: {
          ...(current ? { effort: "low" as const } : {}),
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { addressed: { type: "boolean" } },
              required: ["addressed"],
              additionalProperties: false,
            },
          },
        },
        ...(current ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { timeout, maxRetries: 1 },
    );
    if (response.stop_reason === "refusal") return false;
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return false;
    try {
      return JSON.parse(block.text).addressed === true;
    } catch {
      return false;
    }
  };
}

function prompt(text: string, recent: RecentMessage[]): string {
  const context = recent.length ? recent.map((m) => `${m.from}: ${m.text}`).join("\n") : "(none)";
  return `Recent messages, oldest first:\n${context}\n\nMessage to classify:\n${text}`;
}
