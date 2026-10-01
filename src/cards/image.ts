// The card picture behind /o/[id]/card.png: finds the product photo (from the card, or the
// preview image on its page), fetches it through the SSRF-guarded fetch, and draws the card.
// A photo that can't be found or fetched leaves the card's tile instead; it never fails the card.

import type { CardRow, Store } from "../db/store";
import type { Logger } from "../lib/log";
import { safeFetchImage, safeFetchText } from "../lib/safe-fetch";
import { parseListingHtml } from "../rentals/listing";
import { cardData } from "./cards";
import { renderCard } from "./render";

export interface CardImageDeps {
  store: Pick<Store, "setCardPhoto">;
  logger: Logger;
  fetchImage?: typeof safeFetchImage;
  fetchPage?: typeof safeFetchText;
}

export async function cardImage(row: CardRow, deps: CardImageDeps): Promise<{ png: Uint8Array; hasPhoto: boolean }> {
  const fetchImage = deps.fetchImage ?? safeFetchImage;
  const fetchPage = deps.fetchPage ?? safeFetchText;
  let photoUrl = row.photoUrl ?? undefined;
  if (!photoUrl && row.pageUrl) {
    try {
      const page = await fetchPage(row.pageUrl);
      photoUrl = parseListingHtml(page.url, page.text).photoUrl;
      if (photoUrl) await deps.store.setCardPhoto(row.id, photoUrl);
    } catch (err) {
      deps.logger.info("cards.page_unreadable", { cardId: row.id, error: (err as Error).message });
    }
  }
  let photo: string | undefined;
  if (photoUrl) {
    try {
      const img = await fetchImage(photoUrl);
      photo = `data:${img.type};base64,${toBase64(img.bytes)}`;
    } catch (err) {
      deps.logger.info("cards.photo_unavailable", { cardId: row.id, error: (err as Error).message });
    }
  }
  return { png: await renderCard({ ...cardData(row), ...(photo ? { photo } : {}) }), hasPhoto: !!photo };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
