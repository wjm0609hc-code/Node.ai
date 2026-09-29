// Tool framework for Nod's Claude orchestration. Each Phase 1 feature
// (rental cards, votes, payments, the tab, ...) registers its tools here.
// Tools get the calling chat and person, so permission checks live in the
// tool itself, next to the action they guard.

import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ChatMember, Store } from "../db/store";
import type { Logger } from "../lib/log";
import type { MessagingProvider, Phone } from "../messaging/types";

export type ChatInfo =
  | { kind: "group"; groupId: string; providerGroupId: string; name: string | null }
  | { kind: "private" };

export interface ToolContext {
  store: Store;
  provider: MessagingProvider;
  logger: Logger;
  chat: ChatInfo;
  caller: { userId: string; name: string; phone: Phone };
  /** Members of the current group; empty in a private chat. */
  members: ChatMember[];
  /** Offer an image for Nod's reply (e.g. a listing photo). Sent only if exactly one is offered, so the reply stays one message. */
  attach?: (mediaUrl: string) => void;
}

/** The subset of JSON Schema Nod's tools use. Strict tool use needs additionalProperties: false. */
export type JsonSchema =
  | { type: "string"; enum?: string[]; minLength?: number; description?: string; format?: string }
  | { type: "integer" | "number"; minimum?: number; maximum?: number; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; items: JsonSchema; description?: string }
  | ObjectSchema;

export interface ObjectSchema {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: string[];
  additionalProperties: false;
  description?: string;
}

export interface NodTool<I = unknown> {
  name: string;
  /** Written for Claude: when to use it, and what it does. */
  description: string;
  inputSchema: ObjectSchema;
  run(input: I, ctx: ToolContext): Promise<string | Record<string, unknown>>;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export function defineTool<I>(tool: NodTool<I>): NodTool<I> {
  return tool;
}

export function createToolRegistry(tools: NodTool<any>[]) {
  const byName = new Map<string, NodTool<any>>();
  for (const t of tools) {
    if (byName.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    byName.set(t.name, t);
  }

  return {
    /** Tool definitions for the Messages API. */
    definitions() {
      return tools.map(
        (t): BetaTool => ({
          name: t.name,
          description: t.description,
          input_schema: forApi(t.inputSchema) as BetaTool["input_schema"],
          strict: true,
        }),
      );
    },

    async run(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const tool = byName.get(name);
      if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
      const problem = validate(tool.inputSchema, input, "input");
      if (problem) return { content: `Invalid input: ${problem}`, isError: true };
      try {
        const out = await tool.run(input, ctx);
        return { content: typeof out === "string" ? out : JSON.stringify(out), isError: false };
      } catch (err) {
        if (err instanceof ToolError) return { content: err.message, isError: true };
        ctx.logger?.error("agent.tool_failed", { tool: name, error: (err as Error).name });
        return { content: `${name} failed. Tell the group briefly that it didn't work.`, isError: true };
      }
    },
  };
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;

/** Throw from a tool to show Claude a specific, safe message (e.g. a permission refusal). */
export class ToolError extends Error {}

// Strict tool use supports a subset of JSON Schema; value constraints are checked locally by validate().
function forApi(schema: JsonSchema): Record<string, unknown> {
  const { minLength: _a, minimum: _b, maximum: _c, ...rest } = schema as JsonSchema & { minLength?: number; minimum?: number; maximum?: number };
  if (schema.type === "object") {
    return { ...rest, properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, forApi(v)])) };
  }
  if (schema.type === "array") return { ...rest, items: forApi(schema.items) };
  return rest;
}

function validate(schema: JsonSchema, value: unknown, path: string): string | null {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path} must be an object`;
      const obj = value as Record<string, unknown>;
      for (const key of schema.required) if (obj[key] === undefined) return `${key} is required`;
      for (const [key, v] of Object.entries(obj)) {
        const prop = schema.properties[key];
        if (!prop) return `unexpected field ${key}`;
        if (v === undefined || v === null) continue;
        const p = validate(prop, v, key);
        if (p) return p;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${path} must be a string`;
      if (schema.minLength && value.length < schema.minLength) return `${path} must not be empty`;
      if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
      return null;
    case "integer":
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) return `${path} must be a number`;
      if (schema.type === "integer" && !Number.isInteger(value)) return `${path} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean`;
    case "array":
      if (!Array.isArray(value)) return `${path} must be a list`;
      for (let i = 0; i < value.length; i++) {
        const p = validate(schema.items, value[i], `${path}[${i}]`);
        if (p) return p;
      }
      return null;
  }
}
