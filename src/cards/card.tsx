// Nod's product cards: the bubble people see for anything from outside the chat (a rental,
// a restaurant, a concert, a pay request). Drawn as an image and sent as a photo, so it looks
// the same in every chat and doesn't depend on link previews. Layout follows the reference:
// a photo with a number badge, the source in small grey, the name in bold, the price in green,
// one line of details, then a footer with the date and Nod's mark.

import type { ReactElement } from "react";

export interface CardData {
  /** 1, 2, 3… when the card is one of several options people pick between. */
  number?: number;
  /** The product photo: an https URL already fetched into a data: URI, or a data: URI. */
  photo?: string;
  /** Where it's from: "Airbnb", "Resy", "Ticketmaster", or the venue's site. */
  source: string;
  title: string;
  /** "$310/night", "$$$", "from $85", "$50". */
  price?: string;
  /** One line: "Sleeps 8 · 3 bedrooms · ★ 4.9", "Sat Oct 10 · 8:00 PM · 6 people". */
  details?: string;
  /** What tapping does, for the text beside the picture ("Book on Resy"). Not drawn. */
  linkLabel?: string;
  /** Bottom-left: dates or a status ("Oct 9–12", "Booked", "Due Fri"). */
  footer?: string;
  /** Shown large in place of a photo when there isn't one (defaults to the title's first letter). */
  glyph?: string;
  /** For events without a photo: a calendar-style tile ("OCT" over "10"). */
  dateTile?: { month: string; day: string };
}

// Short and wide, so a card takes little room in the chat: iMessage shows a picture at the bubble's
// width, so height is what fills the screen. Photo square on the left, words on the right.
export const CARD_WIDTH = 1000;
export const CARD_HEIGHT = 400;
const PHOTO = 316;

const INK = "#1c1c1e";
const GREY = "#8e8e93";
const FAINT = "#b8b8bd";
const GREEN = "#2e9e5b";

export function Card({ card }: { card: CardData }): ReactElement {
  return (
    <div style={{ width: CARD_WIDTH, height: CARD_HEIGHT, display: "flex", padding: 20, background: "transparent" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          background: "#ffffff",
          borderRadius: 36,
          padding: 22,
          boxShadow: "0 8px 26px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.06)",
          fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", position: "relative", width: PHOTO, height: PHOTO, flexShrink: 0, borderRadius: 24, overflow: "hidden", background: "#f3eee8" }}>
          {card.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={card.photo} width={PHOTO} height={PHOTO} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : card.dateTile ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#f6f5f3" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 190, borderRadius: 32, background: "#fff", boxShadow: "0 6px 20px rgba(0,0,0,0.10)", overflow: "hidden" }}>
                <div style={{ display: "flex", width: "100%", justifyContent: "center", background: "#ff3b30", color: "#fff", fontSize: 34, fontWeight: 700, padding: "12px 0 10px", letterSpacing: 3 }}>
                  {card.dateTile.month.toUpperCase()}
                </div>
                <div style={{ display: "flex", fontSize: 110, fontWeight: 600, color: INK, padding: "6px 0 16px", lineHeight: 1 }}>{card.dateTile.day}</div>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 150, fontWeight: 700, color: "#d9cfc3" }}>
              {card.glyph ?? (card.title.trim()[0] ?? "N").toUpperCase()}
            </div>
          )}
          {card.number !== undefined ? (
            <div
              style={{
                position: "absolute",
                top: 16,
                left: 16,
                width: 52,
                height: 52,
                borderRadius: 14,
                background: "rgba(28,28,30,0.92)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 30,
                fontWeight: 600,
              }}
            >
              {String(card.number)}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 30, flex: 1, minWidth: 0, paddingTop: 4 }}>
          <div style={{ fontSize: 26, color: GREY, fontWeight: 500 }}>{clip(card.source, 36)}</div>
          <div style={{ fontSize: 40, color: INK, fontWeight: 700, lineHeight: 1.12, marginTop: 6 }}>{clip(card.title, 40)}</div>
          {card.price ? <div style={{ fontSize: 34, color: GREEN, fontWeight: 600, marginTop: 8 }}>{clip(card.price, 28)}</div> : null}
          {card.details ? <Details text={clip(card.details, 40)} /> : null}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto" }}>
            <div style={{ fontSize: 24, color: FAINT }}>{clip(card.footer ?? "", 38)}</div>
            <div style={{ fontSize: 24, color: FAINT, fontWeight: 600, letterSpacing: -0.5 }}>nod</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The details line; "★" is drawn, since the bundled font doesn't have it. */
function Details({ text }: { text: string }): ReactElement {
  const parts = text.split("★");
  return (
    <div style={{ display: "flex", alignItems: "center", fontSize: 27, color: GREY, marginTop: 8 }}>
      {parts.flatMap((part, i) => [
        ...(i > 0 ? [<Star key={`s${i}`} />] : []),
        <span key={`t${i}`} style={{ whiteSpace: "pre" }}>{part}</span>,
      ])}
    </div>
  );
}

const STAR = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#8e8e93" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>')}`;

function Star(): ReactElement {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={STAR} width={24} height={24} style={{ marginRight: 4, marginTop: -2 }} />;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
