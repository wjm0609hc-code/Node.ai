// Web search (Phase 1 step 6): "find us fun things to do in Tulum on Saturday
// night". Claude calls search_web with only the request details; picks are saved
// as options so the group can vote on them (step 7) and book them (step 8).

import type { ContextSection } from "../agent/context";
import { defineTool, ToolError, type NodTool } from "../agent/tools";
import type { Option, Store } from "../db/store";
import type { Logger } from "../lib/log";
import { normalizeListingUrl } from "../rentals/listing";
import { formatPickCard, type Pick, type Searcher } from "./picks";

export interface WebSearchDeps {
  store: Store;
  searcher: Searcher;
  logger: Logger;
  /** Public web app URL, for the full results page. */
  appUrl?: string;
  now?: () => Date;
}

/** Searches per chat per hour. Each search is several paid web searches. */
const HOURLY_LIMIT = 10;

export function createWebSearch(deps: WebSearchDeps) {
  const { store, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const searchWeb = defineTool<{ query: string; location?: string; when?: string; party_size?: number; preferences?: string[] }>({
    name: "search_web",
    description:
      "Search the web for restaurants, bars, activities, events and things to do, when someone asks you to find or suggest some. " +
      "Pass only what the search needs: what they want, the place, the day and time (resolve 'Saturday night' to a date), group size, " +
      "and preferences such as 'vegetarian' or 'not too loud'. Never include names or chat messages. If the place or day is unclear, " +
      "ask one short question instead of searching. Returns picks as one-line cards with option ids, and a results page link. " +
      "Reply with the best 3 to 5 cards, one per line, then the results page link.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "What to find, e.g. 'fun things to do at night' or 'tacos near the beach'." },
        location: { type: "string", description: "Town or area, e.g. 'Tulum, Mexico'." },
        when: { type: "string", description: "The day and time asked about, as a date, e.g. 'Saturday, October 3, 2026, evening'." },
        party_size: { type: "integer", minimum: 1 },
        preferences: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const scope = ctx.chat.kind === "group" ? { groupId: ctx.chat.groupId } : { dmUserId: ctx.caller.userId };
      const recent = await store.countSearchesSince(scope, new Date(now().getTime() - 60 * 60 * 1000));
      if (recent >= HOURLY_LIMIT) throw new ToolError("This chat has searched a lot in the last hour. Try again a bit later.");

      let picks: Pick[];
      try {
        ({ picks } = await deps.searcher({
          query: input.query,
          location: input.location,
          when: input.when,
          partySize: input.party_size,
          preferences: input.preferences ?? [],
        }));
      } catch (err) {
        logger.error("search.failed", { error: (err as Error).message });
        throw new ToolError("The search didn't work this time. Tell them briefly and offer to try again.");
      }

      const search = await store.createSearch({
        groupId: ctx.chat.kind === "group" ? ctx.chat.groupId : null,
        requestedByUserId: ctx.caller.userId,
        query: input.query,
        location: input.location ?? null,
        whenText: input.when ?? null,
        results: { picks },
      });
      logger.info("search.done", { searchId: search.id, picks: picks.length });

      const cards = [];
      for (const pick of picks) {
        if (ctx.chat.kind !== "group") {
          cards.push({ card: formatPickCard(pick) });
          continue;
        }
        const url = normalizeListingUrl(pick.url) ?? pick.url;
        const { option, created } = await store.upsertOption({
          groupId: ctx.chat.groupId,
          kind: pick.kind,
          source: "search",
          url,
          postedByUserId: null,
          providerMessageId: null,
        });
        if (created) {
          await store.updateOptionParsed(option.id, {
            title: pick.name,
            summary: pick.summary,
            ...(pick.when ? { when: pick.when } : {}),
            ...(pick.priceHint ? { priceHint: pick.priceHint } : {}),
            ...(pick.address ? { address: pick.address } : {}),
            ...(pick.bookingUrl ? { bookingUrl: pick.bookingUrl } : {}),
            searchId: search.id,
          });
        }
        cards.push({ option_id: option.id, card: formatPickCard(pick) });
      }

      return {
        search_id: search.id,
        picks: cards,
        ...(deps.appUrl ? { results_page: `${deps.appUrl}/s/${search.id}` } : {}),
        ...(picks.length ? {} : { note: "Nothing confirmed turned up. Say so, and suggest a different search." }),
      };
    },
  });

  const section: ContextSection = async (call) => {
    if (!call.groupId) return null;
    const found = (await store.listOptions(call.groupId)).filter((o) => o.source === "search").slice(-8);
    if (!found.length) return null;
    return { title: "search_options", body: found.map((o) => `[option ${o.id}] ${formatPickCard(pickOf(o))}`).join("\n") };
  };

  const tools: NodTool<any>[] = [searchWeb];
  return { tools, section };
}

function pickOf(o: Option): Pick {
  const p = o.parsed as Record<string, string | undefined>;
  return {
    name: p.title ?? o.url,
    kind: o.kind === "rental" || o.kind === "ticket" ? "other" : o.kind,
    summary: p.summary ?? "",
    url: o.url,
    when: p.when,
    priceHint: p.priceHint,
  };
}
