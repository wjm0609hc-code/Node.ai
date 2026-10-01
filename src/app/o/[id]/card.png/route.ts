// The card picture for a card link (its link-preview image, and the picture sent in SMS groups).
import { cardImage } from "../../../../cards/image";
import { consoleLogger } from "../../../../lib/log";
import { getStore } from "../../../../server/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const store = await getStore();
  const row = await store.getCard(id);
  if (!row) return new Response("Not found", { status: 404 });
  const { png, hasPhoto } = await cardImage(row, { store, logger: consoleLogger() });
  return new Response(png as BodyInit, {
    headers: {
      "content-type": "image/png",
      // A card never changes; one drawn without its photo is retried later.
      "cache-control": hasPhoto ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    },
  });
}
