// Turns a CardData into a PNG with Next's image renderer (satori + resvg, bundled in next/og).

import { readFile } from "node:fs/promises";
import { ImageResponse } from "next/og";
import { Card, CARD_HEIGHT, CARD_WIDTH, type CardData } from "./card";

let fonts: Promise<Array<{ name: string; data: ArrayBuffer; weight: 400 | 500 | 600 | 700; style: "normal" }>> | undefined;

// Written out one by one so the bundler copies each font file into the build.
const FONT_FILES = {
  400: new URL("./fonts/inter-400.woff", import.meta.url),
  500: new URL("./fonts/inter-500.woff", import.meta.url),
  600: new URL("./fonts/inter-600.woff", import.meta.url),
  700: new URL("./fonts/inter-700.woff", import.meta.url),
} as const;

function loadFonts() {
  fonts ??= Promise.all(
    ([400, 500, 600, 700] as const).map(async (weight) => {
      const buf = await readFile(FONT_FILES[weight]);
      return { name: "Inter", data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, weight, style: "normal" as const };
    }),
  );
  return fonts;
}

export async function renderCard(card: CardData): Promise<Uint8Array> {
  const res = new ImageResponse(<Card card={card} />, { width: CARD_WIDTH, height: CARD_HEIGHT, fonts: await loadFonts() });
  return new Uint8Array(await res.arrayBuffer());
}
