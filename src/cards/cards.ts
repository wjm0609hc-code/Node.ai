// Nod's product cards as tappable links. Each card is saved with a short id; its link
// (/o/[id]) shows the card as the link's preview picture and forwards a tap to the real
// page. In iMessage the card goes out as a link bubble; in SMS groups, where previews are
// unreliable, as the card picture with the link under it. Browser-safe (the simulator uses it).

import { promoFor, promoLine } from "../affiliates/affiliates";
import type { CardRow, Store } from "../db/store";
import type { OutboundContent, Service } from "../messaging/types";
import type { CardData } from "./card";
import type { CardSpec } from "./spec";

export interface CardLink {
  id: string;
  /** The link people tap: {appUrl}/o/{id}. */
  url: string;
  /** The card picture: {appUrl}/o/{id}/card.png. */
  imageUrl: string;
  title: string;
  /** What tapping does ("Book on Resy"), shown with the link. */
  label?: string;
  /** A program's promo code for the destination ("Code NOD10: $10 off your first order."). */
  promo?: string;
}

export interface CardsDeps {
  store: Store;
  appUrl?: string;
  newId?: () => string;
}

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 12 characters from 57: unguessable enough that card links can't be enumerated. */
export function newCardId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  let id = "";
  for (const b of bytes) {
    if (b < 228 && id.length < 12) id += ALPHABET[b % ALPHABET.length]; // 228 = 4 × 57, so every character is equally likely
  }
  return id.length === 12 ? id : newCardId();
}

export function linkFor(appUrl: string | undefined, id: string, title: string, label?: string, promo?: string): CardLink {
  const base = (appUrl ?? "").replace(/\/$/, "");
  return { id, url: `${base}/o/${id}`, imageUrl: `${base}/o/${id}/card.png`, title, ...(label ? { label } : {}), ...(promo ? { promo } : {}) };
}

/** A saved card's link, with its label and promo code as they were when it was made. */
export function linkForRow(appUrl: string | undefined, row: Pick<CardRow, "id" | "data">): CardLink {
  const str = (k: string) => (typeof row.data[k] === "string" ? (row.data[k] as string) : undefined);
  return linkFor(appUrl, row.id, str("title") ?? "", str("linkLabel"), str("promo"));
}

/** Only http(s) pages are ever a card's destination. */
export function safeTarget(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function createCards(deps: CardsDeps) {
  const { store } = deps;
  const newId = deps.newId ?? newCardId;

  async function make(groupId: string | null, spec: CardSpec): Promise<CardLink> {
    const targetUrl = safeTarget(spec.targetUrl);
    if (!targetUrl) throw new Error("a card needs an http(s) destination");
    const promo = promoFor(targetUrl);
    const row = await store.createCard({
      id: newId(),
      groupId,
      data: { ...(spec.data as unknown as Record<string, unknown>), ...(promo ? { promo: promoLine(promo) } : {}) },
      photoUrl: spec.photoUrl ? (safeTarget(spec.photoUrl) ?? null) : null,
      pageUrl: spec.pageUrl ? (safeTarget(spec.pageUrl) ?? null) : null,
      targetUrl,
    });
    return linkForRow(deps.appUrl, row);
  }

  return { make, content: cardContent, get: (id: string) => store.getCard(id) };
}

/**
 * The message that carries a card: its picture, with the place's name and the link as text.
 * Pictures show at once. A bare link only previews for some people (iMessage showed "Tap to load
 * preview" for Sendblue-sent links, even with Nod saved) and showed up as a second bubble beside the
 * picture; with words around it, the link stays a plain tappable link.
 */
export function cardContent(card: CardLink, _service?: Service | null): OutboundContent {
  return { text: cardCaption(card), mediaUrls: [card.imageUrl] };
}

export function cardCaption(card: CardLink): string {
  const name = [card.title, card.label].map((s) => s?.trim().replace(/\s+/g, " ").slice(0, 60)).filter(Boolean).join(" · ");
  const caption = name ? `${name}: ${card.url} (tap to open)` : `Tap to open: ${card.url} (more details)`;
  return card.promo ? `${caption}. ${card.promo}` : caption;
}

export function cardData(row: CardRow): Omit<CardData, "photo"> {
  return row.data as unknown as Omit<CardData, "photo">;
}

export type Cards = ReturnType<typeof createCards>;
