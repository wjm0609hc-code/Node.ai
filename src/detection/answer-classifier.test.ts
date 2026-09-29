import { describe, expect, it, vi } from "vitest";
import type { ClassifierClient } from "./classifier";
import { createClaudeAnswerClassifier } from "./answer-classifier";

function fake(textOut: string, stop_reason = "end_turn") {
  const create = vi.fn(async (_body: any, _opts?: any) => ({ stop_reason, content: [{ type: "text", text: textOut }] }));
  return { client: { beta: { messages: { create } } } as unknown as ClassifierClient, create };
}

describe("createClaudeAnswerClassifier", () => {
  it("asks whether the message answers Nod's question, with structured output", async () => {
    const f = fake('{"answers":true}');
    const classify = createClaudeAnswerClassifier({ client: f.client });
    expect(await classify({ question: "Jake, what's the price?", answer: "$310" })).toBe(true);
    const [body, opts] = f.create.mock.calls[0]!;
    expect(body.system).toContain("Does this message answer the assistant's question?");
    expect(body.messages[0].content).toContain("Nod asked: Jake, what's the price?");
    expect(body.messages[0].content).toContain("Their next message: $310");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.fallbacks).toBe("default");
    expect(opts).toMatchObject({ maxRetries: 1 });
  });

  it("fails closed", async () => {
    expect(await createClaudeAnswerClassifier({ client: fake('{"answers":false}').client })({ question: "q", answer: "a" })).toBe(false);
    expect(await createClaudeAnswerClassifier({ client: fake("", "refusal").client })({ question: "q", answer: "a" })).toBe(false);
    expect(await createClaudeAnswerClassifier({ client: fake("yes").client })({ question: "q", answer: "a" })).toBe(false);
  });
});
