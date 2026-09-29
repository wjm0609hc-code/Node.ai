// Follow-up answers: does this message answer the question Nod just asked this
// person? Fails closed, like the ambiguous-"nod" classifier.

import Anthropic from "@anthropic-ai/sdk";
import type { AnswerClassifier } from "./addressed";
import type { ClassifierClient } from "./classifier";

const SYSTEM = `An AI assistant named Nod, in a group chat, asked one person a question. You see the question and that person's next message.
Does this message answer the assistant's question? A short or partial answer counts ("$310", "yes", "Saturday", "she owes me 40"). Small talk, a message to someone else, or a new topic does not.`;

const CURRENT_GEN = /^claude-(?:opus-5|fable-5|sonnet-5-5)/;

export function createClaudeAnswerClassifier(opts: { client?: ClassifierClient; model?: string; timeoutMs?: number } = {}): AnswerClassifier {
  let client = opts.client;
  const model = opts.model ?? process.env.NOD_CLASSIFIER_MODEL ?? "claude-opus-5-5";
  const current = CURRENT_GEN.test(model);

  return async ({ question, answer }) => {
    client ??= new Anthropic();
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 256,
        system: SYSTEM,
        messages: [{ role: "user", content: `Nod asked: ${question}\n\nTheir next message: ${answer}` }],
        output_config: {
          ...(current ? { effort: "low" as const } : {}),
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { answers: { type: "boolean" } }, required: ["answers"], additionalProperties: false },
          },
        },
        ...(current ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { timeout: opts.timeoutMs ?? 5000, maxRetries: 1 },
    );
    if (response.stop_reason === "refusal") return false;
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return false;
    try {
      return JSON.parse(block.text).answers === true;
    } catch {
      return false;
    }
  };
}
