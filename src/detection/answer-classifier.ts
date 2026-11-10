// Follow-up answers: does this message answer the question Nod just asked this
// person? Fails closed, like the ambiguous-"nod" classifier.

import Anthropic from "@anthropic-ai/sdk";
import type { AnswerClassifier } from "./addressed";
import type { ClassifierClient } from "./classifier";

const SYSTEM = {
  person: `An AI assistant named Nod, in a group chat, asked one person a question. You see the question and that person's next message.
Does this message answer the assistant's question? A short or partial answer counts ("$310", "yes", "Saturday", "she owes me 40"). Small talk, a message to someone else, or a new topic does not.`,
  group: `An AI assistant named Nod, in a group chat, asked the whole group a question. You see the question and one member's message.
Does this message answer the assistant's question? A short or partial answer counts ("6 of us", "Saturday", "West Village", "yes"). Small talk, reactions ("lol", "omw"), a message to someone else, or a new topic does not.`,
  caller: `An AI assistant named Nod, in a group chat, just replied to the person who asked it for something. You see Nod's reply and that person's next message.
Is the message meant for Nod? Yes if it answers what Nod asked, or adds to or changes their request ("actually make it 8pm", "for 6 instead", "and find drinks after", "the second one", "yes do it"). No if it's talk with the rest of the group, a reaction ("lol", "nice", "thanks"), or a new topic with friends. When unsure, no.`,
  update: `An AI assistant named Nod, in a group chat, asked the whole group a question, and someone already answered. You see the question, the answer so far, and a new message from a member.
Does the new message clearly change that answer: a different number, day, time or place ("actually make it 7", "Jake's coming too so 7", "add one more", "Sarah can't make it", "let's do Friday instead")? Agreement, excitement ("yay Jake's coming!"), jokes or other chat do not, even if they hint at a change. When unsure, no.`,
} as const;

const CURRENT_GEN = /^claude-(?:opus-5|fable-5|sonnet-5-5)/;

export function createClaudeAnswerClassifier(opts: { client?: ClassifierClient; model?: string; timeoutMs?: number } = {}): AnswerClassifier {
  let client = opts.client;
  const model = opts.model ?? process.env.NOD_CLASSIFIER_MODEL ?? "claude-opus-5-5";
  const current = CURRENT_GEN.test(model);

  return async ({ question, answer, mode = "person", answered }) => {
    client ??= new Anthropic();
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 256,
        system: SYSTEM[mode],
        messages: [
          {
            role: "user",
            content:
              mode === "update"
                ? `Nod asked the group: ${question}\n\nThe answer so far: ${answered ?? ""}\n\nA member's new message: ${answer}`
                : `${mode === "caller" ? "Nod's reply" : "Nod asked"}: ${question}\n\n${mode === "group" ? "A member's message" : "Their next message"}: ${answer}`,
          },
        ],
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
