import { describe, expect, it, vi } from "vitest";
import type { AgentClient } from "../agent/responder";
import { createClaudeSearcher } from "./claude-searcher";

const searchResults = (urls: string[]) => ({
  type: "web_search_tool_result",
  tool_use_id: "s1",
  content: urls.map((url) => ({ type: "web_search_result", url, title: url, encrypted_content: "x" })),
});

function fake(...responses: any[]) {
  const requests: any[] = [];
  const options: any[] = [];
  const create = vi.fn(async (body: any, opts: any) => {
    requests.push(structuredClone(body));
    options.push(opts);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { beta: { messages: { create } } } as unknown as AgentClient, requests, options };
}

const answer = (picks: unknown[]) => ({ type: "text", text: JSON.stringify({ picks }) });

describe("createClaudeSearcher", () => {
  it("sends only the request fields, with the web search tool capped", async () => {
    const f = fake({
      stop_reason: "end_turn",
      content: [
        { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "live music Tulum Saturday" } },
        searchResults(["https://www.batey.mx/", "https://ra.co/events/1"]),
        answer([{ name: "Batey", kind: "activity", summary: "Mojito bar with live salsa", url: "https://batey.mx", when: "Live music from 9pm" }]),
      ],
    });
    const search = createClaudeSearcher({ client: f.client });
    const result = await search({ query: "fun things to do at night", location: "Tulum, Mexico", when: "Saturday, October 3, 2026, evening", partySize: 6, preferences: ["not too loud"] });

    expect(result.picks).toEqual([{ name: "Batey", kind: "activity", summary: "Mojito bar with live salsa", url: "https://batey.mx/", when: "Live music from 9pm" }]);
    const body = f.requests[0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 5, user_location: { type: "approximate", city: "Tulum, Mexico" } }]);
    expect(body.system).toContain("Only include places you found in this search");
    expect(body.messages).toEqual([
      {
        role: "user",
        content:
          "Find: fun things to do at night\nWhere: Tulum, Mexico\nWhen: Saturday, October 3, 2026, evening\nGroup size: 6\nAsked for / must have options for: not too loud (a place with something suitable counts; don't rule out whole cuisines)",
      },
    ]);
    expect(f.options[0]).toMatchObject({ timeout: 120_000, maxRetries: 1 });
  });

  it("continues after pause_turn and drops picks not found in the results", async () => {
    const f = fake(
      { stop_reason: "pause_turn", content: [searchResults(["https://hartwoodtulum.com/"])] },
      {
        stop_reason: "end_turn",
        content: [
          searchResults(["https://arca.mx/"]),
          answer([
            { name: "Hartwood", kind: "restaurant", summary: "Wood-fired", url: "https://www.hartwoodtulum.com/" },
            { name: "Made Up", kind: "restaurant", summary: "?", url: "https://madeup.example/" },
            { name: "Arca", kind: "restaurant", summary: "Tasting menu", url: "https://arca.mx/" },
          ]),
        ],
      },
    );
    const result = await createClaudeSearcher({ client: f.client })({ query: "dinner" });
    expect(result.picks.map((p) => p.name)).toEqual(["Hartwood", "Arca"]);
    expect(f.requests[1].messages).toHaveLength(2);
    expect(f.requests[1].messages[1].role).toBe("assistant");
  });

  it("fails clearly when the answer has no usable JSON", async () => {
    const f = fake({ stop_reason: "end_turn", content: [{ type: "text", text: "I found some places!" }] });
    await expect(createClaudeSearcher({ client: f.client })({ query: "dinner" })).rejects.toThrow(/couldn't read the search results/);
  });

  it("passes on API errors", async () => {
    const f = fake(new Error("overloaded"));
    await expect(createClaudeSearcher({ client: f.client })({ query: "dinner" })).rejects.toThrow("overloaded");
  });
});
