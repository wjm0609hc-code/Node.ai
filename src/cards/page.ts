// The page behind a card link (/o/[id]). Link-preview fetchers (iMessage's included) get a
// page whose preview picture is the card; people who tap are sent straight to the real page.

import type { CardRow } from "../db/store";
import { cardData, linkFor } from "./cards";
import { CARD_HEIGHT, CARD_WIDTH } from "./card";

import { esc, webPage } from "../web/theme";

/** Fetchers that build link previews. Anything else is a person tapping the card. */
const PREVIEW_AGENTS = /bot|crawler|spider|facebookexternalhit|facebot|twitterbot|slackbot|whatsapp|telegram|discord|linkpreview|embedly|preview|skype|linkedin|applebot|googlebot|bingbot|iframely/i;

export function isPreviewFetcher(userAgent: string | null): boolean {
  return !!userAgent && PREVIEW_AGENTS.test(userAgent);
}

export function renderCardPage(row: CardRow, appUrl: string | undefined): string {
  const d = cardData(row);
  const link = linkFor(appUrl, row.id, d.title);
  const description = [d.source, d.price, d.details].filter(Boolean).join(" · ");
  const target = esc(row.targetUrl);
  const head = `<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(d.source)}">
<meta property="og:title" content="${esc(d.title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(link.url)}">
<meta property="og:image" content="${esc(link.imageUrl)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${CARD_WIDTH}">
<meta property="og:image:height" content="${CARD_HEIGHT}">
<meta property="og:image:alt" content="${esc(d.title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(link.imageUrl)}">`;
  return webPage({
    title: d.title,
    head,
    body: `<img src="${esc(link.imageUrl)}" alt="${esc(d.title)}" style="width:100%;height:auto;display:block">
<a class="btn" href="${target}">Open on ${esc(d.source)}</a>`,
    bare: true,
  });
}
