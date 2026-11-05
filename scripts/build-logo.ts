// Writes public/icon.svg and public/nod-logo.png (the contact photo and app icon)
// from src/site/logo.ts. Run with `npm run logo` after changing the mark.
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { nodFaviconSvg, nodIconSvg } from "../src/site/logo";

writeFileSync("public/icon.svg", nodFaviconSvg() + "\n");
await sharp(Buffer.from(nodIconSvg(1024))).resize(512, 512).png().toFile("public/nod-logo.png");
console.log("Wrote public/icon.svg and public/nod-logo.png");
