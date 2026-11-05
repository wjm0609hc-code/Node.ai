// /privacy: a draft for review before launch (src/site/legal.ts).
import { renderPrivacy } from "../../site/legal";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(renderPrivacy(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
