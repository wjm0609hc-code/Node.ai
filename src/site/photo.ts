// Nod's contact photo as a JPEG, for embedding in its contact card (iPhones ignore
// photos linked by URL). Drawn once from the logo and kept in memory.
import sharp from "sharp";
import { nodIconSvg } from "./logo";

let cached: Promise<Uint8Array> | undefined;

/** 256×256 JPEG of the app icon: small enough for a vCard, sharp in a contact bubble. */
export function nodPhotoJpeg(): Promise<Uint8Array> {
  cached ??= sharp(Buffer.from(nodIconSvg(512))).resize(256, 256).jpeg({ quality: 88 }).toBuffer().then((b) => new Uint8Array(b));
  cached.catch(() => (cached = undefined));
  return cached;
}
