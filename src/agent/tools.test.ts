import { describe, expect, it } from "vitest";
import { createToolRegistry, defineTool, type ToolContext } from "./tools";

const ctx = {} as ToolContext;

const echo = defineTool<{ text: string; times?: number; loud?: boolean; tags?: string[]; mood?: "calm" | "hype" }>({
  name: "echo",
  description: "Repeat text.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1 },
      times: { type: "integer" },
      loud: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      mood: { type: "string", enum: ["calm", "hype"] },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async run(input) {
    return input.text.repeat(input.times ?? 1);
  },
});

const boom = defineTool<Record<string, never>>({
  name: "boom",
  description: "Always fails.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run() {
    throw new Error("database exploded at /secret/path");
  },
});

describe("tool registry", () => {
  const registry = createToolRegistry([echo, boom]);

  it("exposes strict API definitions, leaving value constraints to local validation", () => {
    const { minLength: _dropped, ...text } = echo.inputSchema.properties.text as { minLength?: number };
    expect(registry.definitions()).toEqual([
      {
        name: "echo",
        description: "Repeat text.",
        input_schema: { ...echo.inputSchema, properties: { ...echo.inputSchema.properties, text } },
        strict: true,
      },
      { name: "boom", description: "Always fails.", input_schema: boom.inputSchema, strict: true },
    ]);
  });

  it("rejects duplicate names", () => {
    expect(() => createToolRegistry([echo, echo])).toThrow(/duplicate/i);
  });

  it("runs a tool with valid input", async () => {
    expect(await registry.run("echo", { text: "hi", times: 2 }, ctx)).toEqual({ content: "hihi", isError: false });
  });

  it.each([
    [{}, /text is required/],
    [{ text: 5 }, /text must be a string/],
    [{ text: "" }, /text must not be empty/],
    [{ text: "a", times: 1.5 }, /times must be an integer/],
    [{ text: "a", loud: "yes" }, /loud must be a boolean/],
    [{ text: "a", tags: ["x", 2] }, /tags\[1\] must be a string/],
    [{ text: "a", mood: "angry" }, /mood must be one of calm, hype/],
    [{ text: "a", extra: 1 }, /unexpected field extra/],
    ["nope", /input must be an object/],
  ])("returns an error result for invalid input %j", async (input, message) => {
    const result = await registry.run("echo", input, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(message);
  });

  it("turns a thrown error into a short error result without internals", async () => {
    const result = await registry.run("boom", {}, ctx);
    expect(result).toEqual({ content: "boom failed. Tell the group briefly that it didn't work.", isError: true });
  });

  it("reports unknown tools", async () => {
    expect(await registry.run("nope", {}, ctx)).toEqual({ content: "Unknown tool: nope", isError: true });
  });

  it("passes structured results through as JSON", async () => {
    const obj = defineTool<Record<string, never>>({
      name: "obj",
      description: "Returns an object.",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      async run() {
        return { ok: true, count: 2 };
      },
    });
    expect(await createToolRegistry([obj]).run("obj", {}, ctx)).toEqual({ content: '{"ok":true,"count":2}', isError: false });
  });
});
