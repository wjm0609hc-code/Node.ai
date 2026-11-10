// The figures on the private stats page (/admin/stats): which links Nod sends get tapped, by
// link type, site, category and pick position, plus the funnel from searches to bookings.
// Everything is counted per link, never per person: taps carry no phone, IP or browser.

import { affiliateLink, PROGRAMS } from "../affiliates/affiliates";
import { sourceName } from "../cards/spec";
import type { CardWithTaps, UsageStats } from "../db/store";

/** One row of a breakdown: how many cards went out, how many people opened, and how many taps in all. */
export interface Row {
  label: string;
  sent: number;
  /** Cards tapped at least once. */
  tapped: number;
  taps: number;
  /** tapped / sent, 0–1. */
  rate: number;
  /** For sites: the affiliate program that covers it, and whether Nod's tag is on its links. */
  program?: { name: string; on: boolean };
}

export interface Stats {
  days: number;
  since: Date;
  cardsSent: number;
  cardsTapped: number;
  taps: number;
  /** cardsTapped / cardsSent, 0–1. */
  tapRate: number;
  /** Hits within seconds of a card being made: most likely preview fetchers, left out of every figure. */
  earlyTaps: number;
  groups: number;
  funnel: Array<{ label: string; value: number }>;
  byLinkType: Row[];
  bySite: Row[];
  byCategory: Row[];
  byPosition: Row[];
  topPlaces: Row[];
  /** True when the window held more cards than the page reads. */
  truncated: boolean;
}

/** A hit this soon after a card is made is most likely a link-preview fetcher, not a person. */
export const EARLY_TAP_MS = 15_000;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** What the link does: "Book on Resy", "Website", "Directions", "Vote option", "Pay link"… */
export function linkType(c: Pick<CardWithTaps, "data" | "targetUrl">, appUrl?: string): string {
  const d = c.data;
  const own = isOwn(c.targetUrl, appUrl);
  const path = pathOf(c.targetUrl);
  if (d.kind === "pay" || (own && path.startsWith("/pay/"))) return "Pay link";
  if (d.kind === "invite" || (own && path.startsWith("/e/"))) return "Calendar invite";
  if (d.via === "vote" || str(d.footer) === "Tap 👍 to vote") return "Vote option";
  const label = str(d.linkLabel);
  if (label) return label;
  if (d.via === "booking") return "Booking link";
  if (d.kind === "rental") return "Rental listing";
  return "Venue page";
}

const CATEGORIES: Record<string, string> = {
  restaurant: "Restaurants and bars",
  rental: "Rentals",
  activity: "Activities",
  event: "Events",
  ticket: "Tickets",
  other: "Other",
  pay: "Payments",
  invite: "Calendar",
};

export function category(c: Pick<CardWithTaps, "data">): string {
  const k = str(c.data.kind);
  return k ? (CATEGORIES[k] ?? "Other") : "Not recorded (older cards)";
}

/** "Nod" for Nod's own pages, else the site's name ("Resy", "hartwoodtulum.com"). */
export function site(c: Pick<CardWithTaps, "targetUrl">, appUrl?: string): string {
  if (isOwn(c.targetUrl, appUrl)) return "Nod";
  if (hostOf(c.targetUrl) === "maps.apple.com") return "Apple Maps";
  return sourceName(c.targetUrl);
}

export function summarize(u: UsageStats, o: { days: number; since: Date; appUrl?: string; env?: NodeJS.ProcessEnv; cardLimit?: number }): Stats {
  const env = o.env ?? process.env;
  const cards = u.cards;
  const tapped = cards.filter((c) => c.taps > 0);
  const groups = new Set([...cards.map((c) => c.groupId).filter((g): g is string => !!g), ...u.searchGroupIds]);
  const picks = cards.filter((c) => c.data.via === "pick");

  const bySite = breakdown(cards, (c) => site(c, o.appUrl)).map((r) => {
    const sample = cards.find((c) => site(c, o.appUrl) === r.label)!;
    const program = programFor(sample.targetUrl);
    return program ? { ...r, program: { name: program, on: affiliateLink(sample.targetUrl, env) !== sample.targetUrl } } : r;
  });

  return {
    days: o.days,
    since: o.since,
    cardsSent: cards.length,
    cardsTapped: tapped.length,
    taps: sum(cards.map((c) => c.taps)),
    tapRate: cards.length ? tapped.length / cards.length : 0,
    earlyTaps: sum(cards.map((c) => c.earlyTaps)),
    groups: groups.size,
    funnel: [
      { label: "Searches", value: u.searches },
      { label: "Picks sent", value: picks.length },
      { label: "Picks tapped", value: picks.filter((c) => c.taps > 0).length },
      { label: "Votes decided", value: u.votesDecided },
      { label: "Bookings confirmed", value: u.bookingsConfirmed },
    ],
    byLinkType: breakdown(cards, (c) => linkType(c, o.appUrl)),
    bySite: bySite.slice(0, 15),
    byCategory: breakdown(cards, category),
    byPosition: breakdown(
      cards.filter((c) => c.data.via === "pick" || c.data.via === "vote" || typeof c.data.number === "number"),
      (c) => (typeof c.data.number === "number" ? `#${c.data.number}` : "Single card"),
    ).sort((a, b) => positionOrder(a.label) - positionOrder(b.label)),
    topPlaces: breakdown(
      cards.filter((c) => c.data.kind !== "pay" && c.data.kind !== "invite"),
      (c) => str(c.data.title) ?? c.targetUrl,
    )
      .filter((r) => r.taps > 0)
      .sort((a, b) => b.taps - a.taps || b.tapped - a.tapped)
      .slice(0, 10),
    truncated: cards.length >= (o.cardLimit ?? Infinity),
  };
}

function breakdown(cards: CardWithTaps[], key: (c: CardWithTaps) => string): Row[] {
  const rows = new Map<string, Row>();
  for (const c of cards) {
    const label = key(c);
    const r = rows.get(label) ?? { label, sent: 0, tapped: 0, taps: 0, rate: 0 };
    r.sent++;
    if (c.taps > 0) r.tapped++;
    r.taps += c.taps;
    rows.set(label, r);
  }
  return [...rows.values()].map((r) => ({ ...r, rate: r.sent ? r.tapped / r.sent : 0 })).sort((a, b) => b.taps - a.taps || b.sent - a.sent || a.label.localeCompare(b.label));
}

function positionOrder(label: string): number {
  const n = Number(label.slice(1));
  return label.startsWith("#") && Number.isFinite(n) ? n : 1000;
}

function programFor(url: string): string | undefined {
  const host = hostOf(url);
  return host ? PROGRAMS.find((p) => p.hosts.test(host))?.name : undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function isOwn(url: string, appUrl?: string): boolean {
  const host = hostOf(url);
  const own = appUrl ? hostOf(appUrl) : undefined;
  return !!host && !!own && host === own;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
