// The web search itself: a separate Claude call with the server-side web search
// tool. It receives only the request fields (what, where, when, group size,
// preferences), never the chat, so nothing from the conversation reaches the
// search engine.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AgentClient } from "../agent/responder";
import { extractJson, validatePicks, MAX_PICKS, type Searcher, type SearchRequest } from "./picks";

export interface ClaudeSearcherOptions {
  client?: AgentClient;
  /** Defaults to NOD_SEARCH_MODEL, then NOD_MODEL, then claude-opus-5-5. */
  model?: string;
  /** Web searches per request. */
  maxUses?: number;
  timeoutMs?: number;
}

const SYSTEM = `You find things for a group of friends planning time together: restaurants, bars, activities, events, tours.
Search the web, then answer with ONLY a JSON object, no other text:
{"picks": [{"name": string, "kind": "restaurant" | "activity" | "event" | "other", "summary": string, "url": string, "when"?: string, "priceHint"?: string, "address"?: string, "bookingUrl"?: string, "phone"?: string}]}

Rules:
- Only include places you found in this search, and use a url from the search results for each (the place's own site if you found it). Never invent a place, hours, dates or prices.
- Up to ${MAX_PICKS} picks, best first. Match the time asked about: open then, or happening then.
- summary: one short line saying what it is and why it fits. when: hours, showtime or date as found. priceHint: as found ("$$", "$40 per person", "free"); leave it out if you didn't find one.
- bookingUrl: only a reservation or ticket link you actually found. phone: the venue's number, only if you found it.
- If you find nothing that fits, return {"picks": []}.`;

const CURRENT_GEN = /^claude-(?:opus-5|fable-5|sonnet-5-5)/;

export function createClaudeSearcher(opts: ClaudeSearcherOptions = {}): Searcher {
  let client = opts.client;
  const model = opts.model ?? process.env.NOD_SEARCH_MODEL ?? process.env.NOD_MODEL ?? "claude-opus-5-5";
  const current = CURRENT_GEN.test(model);

  return async (request) => {
    client ??= new Anthropic();
    const messages: BetaMessageParam[] = [{ role: "user", content: describe(request) }];
    const seenUrls: string[] = [];
    let final: BetaContentBlock[] = [];

    for (let round = 0; round < 4; round++) {
      const response = await client.beta.messages.create(
        {
          model,
          max_tokens: 16000,
          system: SYSTEM,
          messages,
          tools: [
            {
              type: "web_search_20260209",
              name: "web_search",
              max_uses: opts.maxUses ?? 5,
              ...(request.location ? { user_location: { type: "approximate" as const, city: request.location } } : {}),
            },
          ],
          ...(current ? { output_config: { effort: "low" as const }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { timeout: opts.timeoutMs ?? 120_000, maxRetries: 1 },
      );
      for (const block of response.content) collectUrls(block, seenUrls);
      final = response.content;
      if (response.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: response.content }); // let the server-side search carry on
    }

    const reply = final
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    const parsed = extractJson(reply) as { picks?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.picks)) throw new Error("couldn't read the search results");
    return { picks: validatePicks(parsed.picks, seenUrls) };
  };
}

function describe(r: SearchRequest): string {
  return [
    `Find: ${r.query}`,
    r.location && `Where: ${r.location}`,
    r.when && `When: ${r.when}`,
    r.partySize && `Group size: ${r.partySize}`,
    r.preferences?.length && `Preferences: ${r.preferences.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function collectUrls(block: BetaContentBlock, into: string[]) {
  if (block.type !== "web_search_tool_result") return;
  const content = (block as { content: unknown }).content;
  if (!Array.isArray(content)) return; // an error object: no results
  for (const r of content) if (r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string") into.push((r as { url: string }).url);
}
