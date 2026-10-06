// Web search (Phase 1 step 6): "find us fun things to do in Tulum on Saturday
// night". Claude calls search_web with only the request details; picks are saved
// as options so the group can vote on them (step 7) and book them (step 8).

import type { ContextSection } from "../agent/context";
import { defineTool, ToolError, type NodTool } from "../agent/tools";
import type { Option, Store } from "../db/store";
import type { Logger } from "../lib/log";
import { buildBookingLink } from "../booking/links";
import { cardForOption, sourceName } from "../cards/spec";
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

  const searchWeb = defineTool<{ query: string; location?: string; when?: string; date?: string; time?: string; party_size?: number; preferences?: string[] }>({
    name: "search_web",
    description:
      "Search the web for restaurants, bars, activities, things to do, and events like games, concerts and holiday shows (with where to get tickets), when someone asks you to find or suggest some. " +
      "Pass only what the search needs: what they want, the place, the day and time (resolve 'Saturday night' to a date, and pass date and time too " +
      "so reservation links open on that slot), group size, " +
      "and preferences: what they asked for ('not too loud', 'cheap'), plus the group's must-haves ('vegetarian', 'wheelchair access'), " +
      "which only mean a place must have something that works. Never pass likes and dislikes from group notes, names or chat messages. " +
      "If the place or day is unclear, " +
      "ask one short question instead of searching. Returns picks with option ids, and a results page link. " +
      "In a group, call show_options with the best 3 to 5 picks (they go out as cards) and reply with a line introducing them plus the " +
      "results page link. In a private chat, the top picks go out as cards automatically: reply with one short line introducing them plus the results page link. " +
      "Put the results page link mid-sentence, e.g. 'Full list at <link> if you want more.'",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "What to find, e.g. 'dinner for 8 near Back Bay', 'Bruins tickets' or 'holiday shows'." },
        location: { type: "string", description: "Town or area, e.g. 'Boston, MA'." },
        when: { type: "string", description: "The day and time asked about, as a date, e.g. 'Saturday, October 3, 2026, evening'." },
        date: { type: "string", description: "The local date asked about, YYYY-MM-DD, so reservation links open on that day." },
        time: { type: "string", description: "The local time asked about, HH:MM (24-hour), when there is one, e.g. '19:30' for dinner at 7:30." },
        party_size: { type: "integer", minimum: 1, description: "How many people, so reservation links open with that party size." },
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
      let privateCards = 0;
      for (const pick of picks) {
        const booking = bookingFor(pick, input);
        if (ctx.chat.kind !== "group") {
          // No options in a private chat, so the best picks go out as cards straight from the search.
          if (ctx.cards && ctx.attachCard && privateCards < PRIVATE_CARDS) {
            privateCards++;
            ctx.attachCard(await ctx.cards.make(null, cardForOption(pickAsOption(pick, search.id, booking), { number: privateCards })), `pick:${search.id}:${privateCards}`);
          }
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
            ...(pick.phone ? { phone: pick.phone } : {}),
            searchId: search.id,
          });
        }
        // The reservation page for this request (party size and time), even when the option already existed.
        if (booking) await store.updateOptionParsed(option.id, booking);
        cards.push({ option_id: option.id, card: formatPickCard(pick) });
      }

      return {
        search_id: search.id,
        picks: cards,
        ...(privateCards
          ? {
              cards: `${privateCards} card${privateCards === 1 ? "" : "s"} will follow your reply, numbered 1–${privateCards} in the order of these picks. ` +
                "Reply with one short line introducing them (and the results page link); don't list or describe the picks yourself.",
            }
          : {}),
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

/** The picks a private chat sees as cards (the rest are on the results page). */
const PRIVATE_CARDS = 5;

/** A search pick in the shape cards are drawn from. */
type BookingFields = { bookingLink: string; bookingLabel: string; bookingFooter: string };

/** The pick's reservation page, with the party size and time filled in where the platform allows. */
function bookingFor(pick: Pick, input: { date?: string; time?: string; party_size?: number }): BookingFields | undefined {
  if (!pick.bookingUrl) return undefined;
  let link = pick.bookingUrl;
  let platform: string | undefined;
  if (input.party_size) {
    try {
      const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : undefined;
      const time = input.time && /^\d{2}:\d{2}$/.test(input.time) ? input.time : undefined;
      const built = buildBookingLink(pick.bookingUrl, { partySize: input.party_size, ...(date ? { date } : {}), ...(time ? { time } : {}) });
      link = built.url;
      platform = built.platform;
    } catch {
      return undefined;
    }
  }
  const label = `Book on ${platform ?? sourceName(pick.bookingUrl)}`;
  return { bookingLink: link, bookingLabel: label, bookingFooter: input.party_size ? `${label} · ${input.party_size} people` : label };
}

function pickAsOption(pick: Pick, searchId: string, booking?: BookingFields): { kind: Option["kind"]; url: string; parsed: Record<string, unknown> } {
  return {
    kind: pick.kind,
    url: pick.url,
    parsed: {
      title: pick.name,
      summary: pick.summary,
      ...(pick.when ? { when: pick.when } : {}),
      ...(pick.priceHint ? { priceHint: pick.priceHint } : {}),
      ...(pick.address ? { address: pick.address } : {}),
      ...(booking ?? {}),
      searchId,
    },
  };
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
