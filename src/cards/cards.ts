// Nod's product cards as tappable links. Each card is saved with a short id; its link
// (/o/[id]) shows the card as the link's preview picture and forwards a tap to the real
// page. In iMessage the card goes out as a link bubble; in SMS groups, where previews are
// unreliable, as the card picture with the link under it. Browser-safe (the simulator uses it).

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

export function linkFor(appUrl: string | undefined, id: string, title: string): CardLink {
  const base = (appUrl ?? "").replace(/\/$/, "");
  return { id, url: `${base}/o/${id}`, imageUrl: `${base}/o/${id}/card.png`, title };
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
    const row = await store.createCard({
      id: newId(),
      groupId,
      data: spec.data as unknown as Record<string, unknown>,
      photoUrl: spec.photoUrl ? (safeTarget(spec.photoUrl) ?? null) : null,
      pageUrl: spec.pageUrl ? (safeTarget(spec.pageUrl) ?? null) : null,
      targetUrl,
    });
    return linkFor(deps.appUrl, row.id, spec.data.title);
  }

  return { make, content: cardContent, get: (id: string) => store.getCard(id) };
}

/** The message that carries a card: just the link in iMessage (it previews as the card); picture plus link in SMS. */
/**
 * A card goes out as its picture with the link in the same message, on every service.
 * A bare link relies on iMessage's preview, which Sendblue-sent links showed as "Tap to load
 * preview" even for people who'd saved Nod; the picture shows at once, and the link opens the page.
 */
export function cardContent(card: CardLink, _service?: Service | null): OutboundContent {
  return { text: card.url, mediaUrls: [card.imageUrl] };
}

export function cardData(row: CardRow): Omit<CardData, "photo"> {
  return row.data as unknown as Omit<CardData, "photo">;
}

export type Cards = ReturnType<typeof createCards>;
