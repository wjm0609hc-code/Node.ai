// Nod's contact photo as a JPEG, for embedding in its contact card (iPhones ignore
// photos linked by URL). Drawn once from the logo and kept in memory.
import sharp from "sharp";
import { nodIconSvg } from "./logo";

let cached: Promise<Uint8Array> | undefined;

/** 512×512 JPEG of the app icon, the size iPhones use for contact photos: sharp on the contact bubble and the contact page. */
export function nodPhotoJpeg(): Promise<Uint8Array> {
  cached ??= sharp(Buffer.from(nodIconSvg(1024))).resize(512, 512).jpeg({ quality: 88 }).toBuffer().then((b) => new Uint8Array(b));
  cached.catch(() => (cached = undefined));
  return cached;
}
