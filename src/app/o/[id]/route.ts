// A card link. Link-preview fetchers get the page whose preview picture is the card;
// a person tapping the card goes straight to the real page.
import { cardDestination, isPreviewFetcher, renderCardPage } from "../../../cards/page";
import { appConfig } from "../../../server/config";
import { getStore } from "../../../server/container";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const row = await (await getStore()).getCard(id);
  if (!row) return new Response("This card has expired.", { status: 404 });
  const preview = isPreviewFetcher(req.headers.get("user-agent")) || new URL(req.url).searchParams.has("preview");
  if (!preview) return new Response(null, { status: 302, headers: { location: cardDestination(row), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  return new Response(renderCardPage(row, appConfig().appUrl), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600", "x-robots-tag": "noindex" },
  });
}
