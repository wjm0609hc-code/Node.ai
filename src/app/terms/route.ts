// /terms: a draft for review before launch (src/site/legal.ts).
import { renderTerms } from "../../site/legal";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(renderTerms(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
