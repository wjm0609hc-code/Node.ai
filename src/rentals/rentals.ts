// Rental link cards (Phase 1 step 5): quietly remember rental links posted in a
// group, read a listing's preview when Nod is asked, and keep what people add.

import type { ContextSection } from "../agent/context";
import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool, type ToolContext } from "../agent/tools";
import type { Option, Store } from "../db/store";
import type { MessageCall } from "../inbound/pipeline";
import type { Logger } from "../lib/log";
import { formatRentalCard, isRentalUrl, missingFields, normalizeListingUrl, parseListingHtml, type Listing } from "./listing";

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

  const parseListing = defineTool<{ url: string }>({
    name: "parse_listing",
    description:
      "Read a rental listing link (Airbnb, Vrbo, Booking.com, a villa's own site) from its link preview. Returns a one-line card, " +
      "the fields the page didn't show, and who posted it. Use it when someone asks about or wants to compare rentals. " +
      "Post the card(s) in your reply. If fields are missing, ask the person who posted it, by name, to reply to your message with them. " +
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
        if (listing.photoUrl) ctx.attach?.(listing.photoUrl);
        return { card: formatRentalCard(listing, url), missing: missingFields(listing), read_page: !error };
      }

      let { option } = await store.upsertOption({
        groupId: ctx.chat.groupId,
        kind: "rental",
        source: "link",
        url,
        postedByUserId: ctx.caller.userId,
        providerMessageId: null,
      });
      const fetchedAt = typeof option.parsed.fetchedAt === "string" ? Date.parse(option.parsed.fetchedAt) : 0;
      const fresh = !option.parsed.fetchError && now().getTime() - fetchedAt < FRESH_MS;
      let readOk = fresh && fetchedAt > 0;
      if (!fresh) {
        const { listing, error } = await read(url);
        const manual = new Set((option.parsed.manualFields as string[] | undefined) ?? []);
        const patch: Record<string, unknown> = { fetchedAt: now().toISOString(), fetchError: error ?? null };
        for (const [k, v] of Object.entries(listing)) if (!manual.has(k)) patch[k] = v;
        await store.updateOptionParsed(option.id, patch);
        option = (await store.getOption(option.id))!;
        readOk = !error;
      }
      const listing = listingOf(option);
      if (listing.photoUrl) ctx.attach?.(listing.photoUrl);
      return {
        option_id: option.id,
        card: formatRentalCard(listing, url),
        missing: missingFields(listing),
        posted_by: await posterName(option),
        read_page: readOk,
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

  const tools: NodTool<any>[] = [parseListing, updateOption];
  return { captureLinks, section, tools };
}

function listingOf(o: Option): Listing {
  const l: Record<string, unknown> = {};
  for (const k of LISTING_KEYS) if (o.parsed[k] !== undefined && o.parsed[k] !== null) l[k] = o.parsed[k];
  return l as Listing;
}
