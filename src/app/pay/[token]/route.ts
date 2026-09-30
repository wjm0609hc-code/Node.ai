// A payer's private pay page. GET shows their share; POST (from the page) creates
// or reuses the card hold and returns what Stripe.js needs. The token is the only
// credential, so it is never logged.
import { notFoundPage, renderPayPage } from "../../../payments/page";
import { getContainer } from "../../../server/container";

export const dynamic = "force-dynamic";
const HTML = { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store", "referrer-policy": "no-referrer" };

async function payments() {
  const { nod } = await getContainer();
  if (!nod.payments) throw new Error("payments aren't configured");
  return nod.payments;
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const view = await (await payments()).payPage(token);
  if (!view) return new Response(notFoundPage(), { status: 404, headers: HTML });
  return new Response(renderPayPage(view), { headers: HTML });
}

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const p = await payments();
  if (!(await p.payPage(token))) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(await p.startPayment(token), { headers: { "cache-control": "no-store" } });
}
