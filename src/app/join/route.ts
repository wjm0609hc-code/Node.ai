// /join?code=NOD-XXXXXX: the page an invite link opens. It only hands the code to
// the Messages app; Nod redeems it when the text arrives (src/invites).
import { normalizeCode } from "../../invites/codes";
import { renderJoinPage } from "../../invites/page";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const raw = new URL(req.url).searchParams.get("code");
  const code = normalizeCode(raw);
  const html = renderJoinPage({ code, invalid: !!raw && !code, nodPhone: process.env.SENDBLUE_FROM_NUMBER ?? "" });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
