import { describe, expect, it, vi } from "vitest";
import { createClaudeClassifier, type ClassifierClient } from "./classifier";

function fakeClient(response: unknown | (() => Promise<unknown>)) {
  const create = vi.fn(async (_body: any, _opts?: any) => (typeof response === "function" ? (response as any)() : response));
  const client = { beta: { messages: { create } } } as unknown as ClassifierClient;
  return { client, create };
}

const reply = (json: string, stop_reason = "end_turn") => ({
  stop_reason,
  content: [{ type: "text", text: json }],
});

describe("createClaudeClassifier", () => {
  it("returns true on {addressed: true}", async () => {
    const { client } = fakeClient(reply('{"addressed":true}'));
    expect(await createClaudeClassifier({ client })({ text: "should we ask nod", recent: [] })).toBe(true);
  });

  it("returns false on {addressed: false}", async () => {
    const { client } = fakeClient(reply('{"addressed":false}'));
    expect(await createClaudeClassifier({ client })({ text: "he gave me the nod", recent: [] })).toBe(false);
  });

  it("returns false on a refusal or unparseable output", async () => {
    expect(await createClaudeClassifier({ client: fakeClient(reply("", "refusal")).client })({ text: "x nod", recent: [] })).toBe(false);
    expect(await createClaudeClassifier({ client: fakeClient(reply("yes")).client })({ text: "x nod", recent: [] })).toBe(false);
  });

  it("sends a structured-output request with the question, the message and recent context", async () => {
    const { client, create } = fakeClient(reply('{"addressed":false}'));
    await createClaudeClassifier({ client, timeoutMs: 4000 })({
      text: "gave me the nod",
      recent: [{ from: "Jake", text: "who's booking?" }],
    });

    const [body, opts] = create.mock.calls[0]!;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.system).toContain("Is this message addressed to the assistant named Nod?");
    const userText = body.messages[0].content;
    expect(userText).toContain("gave me the nod");
    expect(userText).toContain("Jake: who's booking?");
    expect(opts).toMatchObject({ timeout: 4000, maxRetries: 1 });
  });

  it("opts into server-side refusal fallbacks on models that support them", async () => {
    const opus = fakeClient(reply('{"addressed":false}'));
    await createClaudeClassifier({ client: opus.client })({ text: "nod", recent: [] });
    expect(opus.create.mock.calls[0]![0]).toMatchObject({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });

    const haiku = fakeClient(reply('{"addressed":false}'));
    await createClaudeClassifier({ client: haiku.client, model: "claude-haiku-4-5" })({ text: "nod", recent: [] });
    const body = haiku.create.mock.calls[0]![0];
    expect(body.fallbacks).toBeUndefined();
    expect(body.output_config.effort).toBeUndefined();
  });

  it("lets API errors propagate so the caller stays silent", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("overloaded");
    });
    await expect(createClaudeClassifier({ client })({ text: "nod", recent: [] })).rejects.toThrow("overloaded");
  });
});
