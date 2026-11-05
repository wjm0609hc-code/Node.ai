// Several cards in one picture: /o/s/{id}-{id}-{id}/sheet.png, numbered in that order. Sent with
// the text that carries each card's link when a reply has more than one card.
import { sheetImage } from "../../../../../cards/image";
import { MAX_SHEET_ROWS } from "../../../../../cards/card";
import { consoleLogger } from "../../../../../lib/log";
import { getStore } from "../../../../../server/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ ids: string }> }): Promise<Response> {
  const { ids } = await params;
  const list = ids.split("-").filter((id) => /^[A-Za-z0-9]{12}$/.test(id)).slice(0, MAX_SHEET_ROWS);
  if (list.length < 2) return new Response("Not found", { status: 404 });
  const store = await getStore();
  const rows = (await Promise.all(list.map((id) => store.getCard(id)))).filter((r) => r !== undefined);
  if (rows.length !== list.length) return new Response("Not found", { status: 404 });
  const { png, hasPhoto } = await sheetImage(rows, { store, logger: consoleLogger() });
  return new Response(png as BodyInit, {
    headers: { "content-type": "image/png", "cache-control": hasPhoto ? "public, max-age=31536000, immutable" : "public, max-age=3600" },
  });
}
