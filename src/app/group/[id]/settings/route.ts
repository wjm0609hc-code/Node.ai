// A member's private settings page for one group, linked from a private message
// (/group/[id]/settings?t=<their token>). GET shows it; POST (its own forms) applies a change.
import { createPrivacy, type PageResult } from "../../../../privacy/privacy";
import { consoleLogger } from "../../../../lib/log";
import { getStore } from "../../../../server/container";

export const dynamic = "force-dynamic";

const privacy = async () => createPrivacy({ store: await getStore(), logger: consoleLogger() });
const respond = ({ status, html }: PageResult) =>
  new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return respond(await (await privacy()).settingsPage(id, new URL(req.url).searchParams.get("t")));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const form = await req.formData().catch(() => null);
  const field = (name: string) => {
    const v = form?.get(name);
    return typeof v === "string" ? v : null;
  };
  return respond(await (await privacy()).settingsAction(id, field("t"), field("action"), field("note")));
}
