// Group memory: what a group has done with Nod, so "@Nod where did we go last time?" or "what
// was that bar from March?" gets an answer. Built from what Nod keeps for good (bookings,
// calendar events, votes, the tab and the places it found or people posted), not from chat
// messages, which are only kept for 30 days. "Forget this chat" deletes messages and notes;
// this history stays, like the tab and bookings do, so nobody loses track of plans or money.

import type { ContextSection } from "../agent/context";
import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool } from "../agent/tools";
import { money } from "../booking/shared";
import type { ChatMember, Option, Store } from "../db/store";

export type HistoryKind = "booking" | "event" | "vote" | "expense" | "place";

export interface HistoryItem {
  /** When it happened (or happens): a booking's or event's time, else when it was recorded. */
  at: Date;
  kind: HistoryKind;
  /** One line, already in the group's local time. */
  text: string;
  /** The option behind it, so Nod can show the place's card again. */
  optionId?: string;
}

export interface HistoryDeps {
  store: Store;
  defaultTimezone: string;
  now?: () => Date;
}

/** Most items recall_group_history returns at once. */
const MAX_RESULTS = 25;
/** Items in the short summary Claude sees on every call. */
const SUMMARY_ITEMS = 5;

const STOP = new Set(["the", "and", "for", "that", "this", "with", "from", "what", "where", "when", "was", "were", "did", "our", "last", "time", "place", "spot", "again", "one", "went", "had", "got", "have", "you", "nod"]);

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const titleOf = (o: Option | undefined) => (o ? (str(o.parsed.title) ?? o.url) : "a place");
const whereOf = (o: Option | undefined) => (o ? (str(o.parsed.area) ?? str(o.parsed.address) ?? str(o.parsed.location)) : undefined);

function day(d: Date, tz: string, now: Date): string {
  const sameYear = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(d) === new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(now);
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(d);
}

function dayTime(d: Date, tz: string, now: Date): string {
  return `${day(d, tz, now)}, ${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d).replace(/ /g, " ")}`;
}

/** Everything the group has done with Nod, newest first. */
export async function groupHistory(store: Store, groupId: string, tz: string, now: Date): Promise<HistoryItem[]> {
  const [options, bookings, events, decisions, ledger, members] = await Promise.all([
    store.listOptions(groupId),
    store.listBookings(groupId),
    store.listEvents(groupId),
    store.listDecisions(groupId),
    store.listLedger(groupId),
    store.groupMembers(groupId),
  ]);
  const byId = new Map(options.map((o) => [o.id, o]));
  const name = (id: string | null) => {
    const m = members.find((x: ChatMember) => x.userId === id);
    return m ? displayName(m) : "someone";
  };
  const items: HistoryItem[] = [];
  const decided = new Set<string>();
  const booked = new Set<string>();

  for (const b of bookings) {
    if (b.status !== "booked" || !b.optionId) continue;
    const o = byId.get(b.optionId);
    booked.add(b.optionId);
    const when = b.startsAt ? (b.allDay ? day(b.startsAt, tz, now) : dayTime(b.startsAt, tz, now)) : undefined;
    const where = whereOf(o);
    items.push({
      at: b.startsAt ?? b.updatedAt,
      kind: "booking",
      text: `Booked ${titleOf(o)}${where ? ` (${where})` : ""} for ${b.partySize}${when ? `, ${when}` : ""}`,
      optionId: b.optionId,
    });
  }

  for (const e of events) {
    if (e.status !== "confirmed" || e.bookingId) continue; // A booking's own invite is already listed as the booking.
    items.push({ at: e.startsAt, kind: "event", text: `${e.title}, ${e.allDay ? day(e.startsAt, tz, now) : dayTime(e.startsAt, tz, now)}${e.location ? `, ${e.location}` : ""}` });
  }

  for (const d of decisions) {
    if (d.kind === "date_poll" || !d.winningOptionId) continue;
    if (d.status !== "decided" && d.status !== "booked" && d.status !== "funded") continue;
    decided.add(d.winningOptionId);
    items.push({ at: d.updatedAt, kind: "vote", text: `Voted on “${d.question}”: ${titleOf(byId.get(d.winningOptionId))} won`, optionId: d.winningOptionId });
  }

  for (const l of ledger) {
    if (l.voidedAt || l.kind !== "expense") continue;
    items.push({ at: l.createdAt, kind: "expense", text: `${l.description}: ${money(l.amountCents, l.currency)}, paid by ${name(l.payerUserId)}` });
  }

  for (const o of options) {
    if (decided.has(o.id) || booked.has(o.id) || str(o.parsed.sameAs)) continue; // Already listed, or a duplicate of another listing.
    const where = whereOf(o);
    const how = o.source === "search" ? "Nod found" : `${name(o.postedByUserId)} shared`;
    items.push({ at: o.createdAt, kind: "place", text: `${how} ${titleOf(o)}${where ? ` (${where})` : ""}, ${o.kind === "rental" ? "a rental" : o.kind}`, optionId: o.id });
  }

  return items.sort((a, b) => +b.at - +a.at);
}

/** Words worth matching in a question like "that taco place from March". */
export function queryWords(q: string): string[] {
  return [...new Set(q.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9$]+/))].filter((w) => w.length >= 3 && !STOP.has(w));
}

export function matches(item: HistoryItem, words: string[]): boolean {
  if (!words.length) return true;
  const text = item.text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return words.some((w) => text.includes(w) || (w.endsWith("s") && text.includes(w.slice(0, -1))));
}

const line = (i: HistoryItem, tz: string, now: Date) => `[${day(i.at, tz, now)}] ${i.text}${i.optionId ? ` (option ${i.optionId})` : ""}`;

export function createHistory(deps: HistoryDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const tzOf = async (groupId: string) => (await store.getGroup(groupId))?.timezone ?? deps.defaultTimezone;

  const recall = defineTool<{ query?: string; kinds?: HistoryKind[]; after?: string; before?: string }>({
    name: "recall_group_history",
    description:
      "Look up what this group has done with Nod, even long after the messages are gone: bookings, calendar events, votes and their winners, expenses on the tab, " +
      "and places Nod found or people shared. Use it for 'where did we go last time', 'that bar from March', 'same place as our last dinner', " +
      "'how much was the Airbnb'. Pass query words for a place, cuisine or thing, with a few alternatives since names vary ('tacos taqueria mexican', 'Lupa', 'airbnb rental'), kinds to narrow it, and after/before (YYYY-MM-DD, " +
      "the group's local dates) for a month or season. Results are newest first with option ids: to send a place again, pass its id to show_options. " +
      "Answer in one short line, and only from what this returns; if nothing matches, say you don't have it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for: a place, cuisine, neighborhood or thing." },
        kinds: { type: "array", items: { type: "string", enum: ["booking", "event", "vote", "expense", "place"] } },
        after: { type: "string", description: "Only things on or after this local date." },
        before: { type: "string", description: "Only things on or before this local date." },
      },
      required: [],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (ctx.chat.kind !== "group") throw new ToolError("Group history is for the group chat. Ask in the group.");
      for (const d of [input.after, input.before]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new ToolError("Write after and before as YYYY-MM-DD.");
      const tz = await tzOf(ctx.chat.groupId);
      const t = now();
      const localDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
      const words = queryWords(input.query ?? "");
      const found = (await groupHistory(store, ctx.chat.groupId, tz, t)).filter(
        (i) =>
          (!input.kinds?.length || input.kinds.includes(i.kind)) &&
          (!input.after || localDay(i.at) >= input.after) &&
          (!input.before || localDay(i.at) <= input.before) &&
          matches(i, words),
      );
      if (!found.length) return { found: 0, note: "Nothing matches. Say you don't have that in the group's history (you only know what happened with Nod)." };
      return {
        found: found.length,
        items: found.slice(0, MAX_RESULTS).map((i) => line(i, tz, t)),
        ...(found.length > MAX_RESULTS ? { more: found.length - MAX_RESULTS, note: "Showing the newest. Narrow it with query, kinds or dates." } : {}),
      };
    },
  });

  /** The group's latest plans, so "same place as last time" works without a lookup. */
  const section: ContextSection = async (call) => {
    if (!call.groupId) return null;
    const tz = await tzOf(call.groupId);
    const t = now();
    const plans = (await groupHistory(store, call.groupId, tz, t)).filter((i) => i.kind !== "place" && i.kind !== "expense").slice(0, SUMMARY_ITEMS);
    if (!plans.length) return null;
    return {
      title: "past_plans",
      body: [...plans.map((i) => line(i, tz, t)), "For anything older, other places or the tab's history, use recall_group_history."].join("\n"),
    };
  };

  const tools: NodTool<any>[] = [recall];
  return { tools, section };
}
