// Full results for one search, linked from Nod's reply. The id is an unguessable UUID.
import { renderSearchPage } from "../../../search/page";
import { getStore } from "../../../server/container";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ searchId: string }> }): Promise<Response> {
  const { searchId } = await params;
  const search = await (await getStore()).getSearch(searchId);
  if (!search) return new Response("Not found", { status: 404 });
  return new Response(renderSearchPage(search), {
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "private, max-age=300" },
  });
}
