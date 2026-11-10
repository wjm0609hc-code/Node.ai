// Rental link cards (Phase 1 step 5): quietly remember rental links posted in a
// group, read a listing's preview when Nod is asked, and keep what people add.

import { cardForOption } from "../cards/spec";
import type { ContextSection } from "../agent/context";
import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool, type ToolContext } from "../agent/tools";
import type { Option, Store } from "../db/store";
import type { MessageCall } from "../inbound/pipeline";
import type { Logger } from "../lib/log";
import { formatRentalCard, isRentalUrl, missingFields, normalizeListingUrl, parseListingHtml, type Listing } from "./listing";
import { noRentalMatcher, type RentalMatcher } from "./matcher";
import { money } from "../booking/shared";

/** Returns a page's HTML or throws with a short reason. */
export type ListingFetcher = (url: string) => Promise<string>;

/** Used when no fetcher is configured (e.g. a test that never reads pages). */
export const noListingFetcher: ListingFetcher = async () => {
  throw new Error("reading links isn't set up here");
};

/** A successful read is reused for a day; failed reads are retried next time. */
const FRESH_MS = 24 * 60 * 60 * 1000;
const LISTING_KEYS = ["title", "photoUrl", "site", "location", "price", "sleeps", "bedrooms", "beds", "baths", "rating", "cancellation"] as const;
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;

export interface RentalsDeps {
  store: Store;
  fetchListing: ListingFetcher;
  /** Looks for the same rental on other sites (compare_rental). */
  matchRental?: RentalMatcher;
  logger: Logger;
  now?: () => Date;
}

export function createRentals(deps: RentalsDeps) {
  const { store, logger } = deps;
  const now = deps.now ?? (() => new Date());

  /** Saves rental links from any readable group message. Nod says nothing (rule 1). */
  async function captureLinks(call: MessageCall): Promise<void> {
    if (!call.groupId || call.optedOut) return;
    for (const raw of call.event.text.match(URL_IN_TEXT) ?? []) {
      const url = normalizeListingUrl(raw.replace(/[.,!?)\]]+$/, ""));
      if (!url || !isRentalUrl(url)) continue;
      const { created } = await store.upsertOption({
        groupId: call.groupId,
        kind: "rental",
        source: "link",
        url,
        postedByUserId: call.senderUserId,
        providerMessageId: call.event.messageId,
      });
      if (created) logger.info("rentals.link_saved", { groupId: call.groupId });
    }
  }

  const section: ContextSection = async (call) => {
    if (!call.groupId) return null;
    const rentals = (await store.listOptions(call.groupId, { kind: "rental" })).slice(-10);
    if (!rentals.length) return null;
    const lines = await Promise.all(
      rentals.map(async (o) => {
        const by = await posterName(o);
        const l = listingOf(o);
        if (!o.parsed.fetchedAt && !Object.keys(l).length) return `[option ${o.id}] ${o.url} (posted by ${by}, not checked yet)`;
        const missing = missingFields(l);
        return `[option ${o.id}] ${formatRentalCard(l, o.url)} (posted by ${by}${missing.length ? `; missing: ${missing.join(", ")}` : ""})`;
      }),
    );
    return { title: "rental_options", body: lines.join("\n") };
  };

  async function posterName(o: Option): Promise<string> {
    const user = o.postedByUserId ? await store.getUser(o.postedByUserId) : undefined;
    return user ? displayName(user) : "someone";
  }

  async function read(url: string): Promise<{ listing: Listing; error?: string }> {
    try {
      return { listing: parseListingHtml(url, await deps.fetchListing(url)) };
    } catch (err) {
      logger.warn("rentals.read_failed", { error: (err as Error).message });
      return { listing: {}, error: (err as Error).message };
    }
  }

  /** Reads a rental option's page unless a recent read is saved; details people gave are never overwritten. */
  async function refresh(option: Option): Promise<{ option: Option; readOk: boolean }> {
    if (option.kind !== "rental") return { option, readOk: true };
    const fetchedAt = typeof option.parsed.fetchedAt === "string" ? Date.parse(option.parsed.fetchedAt) : 0;
    const fresh = !option.parsed.fetchError && now().getTime() - fetchedAt < FRESH_MS;
    if (fresh) return { option, readOk: fetchedAt > 0 };
    const { listing, error } = await read(option.url);
    const manual = new Set((option.parsed.manualFields as string[] | undefined) ?? []);
    const patch: Record<string, unknown> = { fetchedAt: now().toISOString(), fetchError: error ?? null };
    for (const [k, v] of Object.entries(listing)) if (!manual.has(k)) patch[k] = v;
    await store.updateOptionParsed(option.id, patch);
    return { option: (await store.getOption(option.id))!, readOk: !error };
  }

  const parseListing = defineTool<{ url: string }>({
    name: "parse_listing",
    description:
      "Read a rental listing link (Airbnb, Vrbo, Booking.com, a villa's own site) from its link preview. Returns a one-line card, " +
      "the fields the page didn't show, and who posted it. Use it when someone asks about or wants to compare rentals. " +
      "The listing is shown as a card (photo, price, tap to open) after your reply, so don't paste the link; to compare several, " +
      "call show_options with all their option ids afterwards so the cards are numbered. If fields are missing, ask the person who posted it, by name, and call expect_answer_from " +
      "for them so they can just reply without tagging you. " +
      "Never guess prices.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The listing link exactly as posted." } },
      required: ["url"],
      additionalProperties: false,
    },
    async run({ url: raw }, ctx: ToolContext) {
      const url = normalizeListingUrl(raw);
      if (!url) throw new ToolError("That isn't a web link.");

      if (ctx.chat.kind !== "group") {
        const { listing, error } = await read(url);
        if (ctx.cards && ctx.attachCard) ctx.attachCard(await ctx.cards.make(null, cardForOption({ kind: "rental", url, parsed: { ...listing } }, { via: "listing" })), url);
        return { card: formatRentalCard(listing, url), missing: missingFields(listing), read_page: !error, shown_as_card: !!ctx.attachCard };
      }

      const { option: saved } = await store.upsertOption({
        groupId: ctx.chat.groupId,
        kind: "rental",
        source: "link",
        url,
        postedByUserId: ctx.caller.userId,
        providerMessageId: null,
      });
      const refreshed = await refresh(saved);
      const option = refreshed.option;
      const readOk = refreshed.readOk;
      const listing = listingOf(option);
      if (ctx.cards && ctx.attachCard) ctx.attachCard(await ctx.cards.make(ctx.chat.groupId, cardForOption(option, { via: "listing" })), option.id);
      return {
        shown_as_card: !!ctx.attachCard,
        option_id: option.id,
        card: formatRentalCard(listing, url),
        missing: missingFields(listing),
        posted_by: await posterName(option),
        read_page: readOk,
        ...(listing.site === "Airbnb" ? { also: "This is on Airbnb. Call compare_rental once to see whether the same place is listed elsewhere, sometimes for less." } : {}),
      };
    },
  });

  const updateOption = defineTool<{
    option_id: string;
    price_cents?: number;
    price_per?: "night" | "total";
    currency?: string;
    sleeps?: number;
    bedrooms?: number;
    beds?: number;
    baths?: number;
    cancellation?: string;
    title?: string;
  }>({
    name: "update_option",
    description:
      "Save details someone in the chat gave about a rental option (price, how many it sleeps, bedrooms, cancellation policy, name). " +
      "Use the option id from rental_options or parse_listing. Prices are integer cents: $310 is 31000. Returns the updated card.",
    inputSchema: {
      type: "object",
      properties: {
        option_id: { type: "string" },
        price_cents: { type: "integer", minimum: 0, description: "Price in cents, e.g. 31000 for $310." },
        price_per: { type: "string", enum: ["night", "total"] },
        currency: { type: "string", description: "ISO code such as USD or MXN. Defaults to the option's currency, else USD." },
        sleeps: { type: "integer", minimum: 1 },
        bedrooms: { type: "integer", minimum: 0 },
        beds: { type: "integer", minimum: 0 },
        baths: { type: "number", minimum: 0 },
        cancellation: { type: "string" },
        title: { type: "string" },
      },
      required: ["option_id"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (ctx.chat.kind !== "group") throw new ToolError("Options belong to a group chat.");
      const option = await store.getOption(input.option_id);
      if (!option || option.groupId !== ctx.chat.groupId) throw new ToolError("That option isn't in this group.");
      const current = listingOf(option);
      const patch: Record<string, unknown> = {};
      if (input.price_cents !== undefined) {
        patch.price = {
          amountCents: input.price_cents,
          currency: (input.currency ?? current.price?.currency ?? "USD").toUpperCase(),
          per: input.price_per ?? current.price?.per ?? "night",
        };
      }
      for (const k of ["sleeps", "bedrooms", "beds", "baths", "cancellation", "title"] as const) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      if (!Object.keys(patch).length) throw new ToolError("Nothing to update.");
      const manual = new Set([...((option.parsed.manualFields as string[] | undefined) ?? []), ...Object.keys(patch)]);
      await store.updateOptionParsed(option.id, { ...patch, manualFields: [...manual] });
      const updated = listingOf((await store.getOption(option.id))!);
      logger.info("rentals.option_updated", { groupId: ctx.chat.groupId, fields: Object.keys(patch) });
      return { option_id: option.id, card: formatRentalCard(updated, option.url), missing: missingFields(updated) };
    },
  });

  const compareRental = defineTool<{ option_id: string; check_in?: string; check_out?: string; guests?: number }>({
    name: "compare_rental",
    description:
      "Check whether a rental the group is looking at (especially an Airbnb) is also listed on Vrbo, Booking.com, Expedia, Hotels.com " +
      "or Plum Guide, sometimes for less. Use it when someone asks to compare prices, or once when the group looks at an Airbnb listing. " +
      "Pass the stay dates and guests when you know them. Matches are shown as cards after your reply. Say a match is cheaper only " +
      "when the result has cheaper_by; otherwise say it's also listed there. If nothing turns up, don't mention the check.",
    inputSchema: {
      type: "object",
      properties: {
        option_id: { type: "string" },
        check_in: { type: "string", description: "YYYY-MM-DD" },
        check_out: { type: "string", description: "YYYY-MM-DD" },
        guests: { type: "integer", minimum: 1 },
      },
      required: ["option_id"],
      additionalProperties: false,
    },
    async run(input, ctx: ToolContext) {
      if (ctx.chat.kind !== "group") throw new ToolError("Compare rentals in the group chat.");
      const option = await store.getOption(input.option_id);
      if (!option || option.groupId !== ctx.chat.groupId || option.kind !== "rental") throw new ToolError("That isn't a rental in this group.");
      const listing = listingOf(option);
      const dated = !!(input.check_in && input.check_out);
      const cached = option.parsed.crossListing as { checkedAt: string; matchIds: string[]; dated: boolean } | undefined;
      let matchOptions: Option[] = [];
      let evidence = new Map<string, string>();

      if (cached && !(dated && !cached.dated) && now().getTime() - Date.parse(cached.checkedAt) < FRESH_MS) {
        for (const id of cached.matchIds) {
          const o = await store.getOption(id);
          if (o) matchOptions.push(o);
        }
      } else {
        let found;
        try {
          found = await (deps.matchRental ?? noRentalMatcher)({
            listing,
            url: option.url,
            ...(dated ? { checkIn: input.check_in, checkOut: input.check_out } : {}),
            ...(input.guests ? { guests: input.guests } : {}),
          });
        } catch (err) {
          logger.warn("rentals.compare_failed", { error: String(err) });
          throw new ToolError("Couldn't check other sites right now. Don't mention it.");
        }
        for (const m of found.matches) {
          const url = normalizeListingUrl(m.url) ?? m.url;
          const { option: saved } = await store.upsertOption({ groupId: ctx.chat.groupId, kind: "rental", source: "search", url, postedByUserId: null, providerMessageId: null });
          await store.updateOptionParsed(saved.id, {
            title: m.title,
            site: m.site,
            sameAs: option.id,
            ...(listing.location ? { location: listing.location } : {}),
            ...(m.price ? { price: m.price } : {}),
            ...(m.photoUrl ? { photoUrl: m.photoUrl } : listing.photoUrl ? { photoUrl: listing.photoUrl } : {}),
            ...(listing.bedrooms ? { bedrooms: listing.bedrooms } : {}),
            ...(listing.sleeps ? { sleeps: listing.sleeps } : {}),
          });
          matchOptions.push((await store.getOption(saved.id))!);
          evidence.set(saved.id, m.evidence);
        }
        await store.updateOptionParsed(option.id, { crossListing: { checkedAt: now().toISOString(), matchIds: matchOptions.map((o) => o.id), dated } });
        logger.info("rentals.compared", { groupId: ctx.chat.groupId, matches: matchOptions.length });
      }

      if (!matchOptions.length) return { matches: [], note: "Not found on other sites. Don't mention the check." };
      const results = [];
      for (const o of matchOptions) {
        const l = listingOf(o);
        if (ctx.cards && ctx.attachCard) ctx.attachCard(await ctx.cards.make(ctx.chat.groupId, cardForOption(o, { via: o.source === "search" ? "pick" : "listing" })), o.id);
        const cheaper =
          listing.price && l.price && listing.price.per === l.price.per && listing.price.currency === l.price.currency && l.price.amountCents < listing.price.amountCents
            ? `${money(listing.price.amountCents - l.price.amountCents, l.price.currency)}${l.price.per === "night" ? " a night" : " in total"}`
            : undefined;
        results.push({
          option_id: o.id,
          site: l.site,
          ...(l.price ? { price: `${money(l.price.amountCents, l.price.currency)}${l.price.per === "night" ? " a night" : " total"}` } : {}),
          ...(cheaper ? { cheaper_by: cheaper } : {}),
          ...(evidence.get(o.id) ? { why_same: evidence.get(o.id) } : {}),
        });
      }
      return { matches: results, shown_as_cards: !!ctx.attachCard };
    },
  });

  const tools: NodTool<any>[] = [parseListing, updateOption, compareRental];
  return { captureLinks, section, tools, refresh };
}

function listingOf(o: Option): Listing {
  const l: Record<string, unknown> = {};
  for (const k of LISTING_KEYS) if (o.parsed[k] !== undefined && o.parsed[k] !== null) l[k] = o.parsed[k];
  return l as Listing;
}
