// A payee's payout setup link: sends them to Stripe's onboarding, and back here when done.
import { notFoundPage, renderPayoutPage } from "../../../payments/page";
import { getContainer } from "../../../server/container";

export const dynamic = "force-dynamic";
const HTML = { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store", "referrer-policy": "no-referrer" };

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const { nod } = await getContainer();
  if (!nod.payments) return new Response(notFoundPage(), { status: 404, headers: HTML });
  const returning = new URL(req.url).searchParams.has("done");
  const result = await nod.payments.payoutSetup(token, { returning });
  if (!result) return new Response(notFoundPage(), { status: 404, headers: HTML });
  if ("ready" in result) return new Response(renderPayoutPage("ready"), { headers: HTML });
  if (returning) return new Response(renderPayoutPage("pending"), { headers: HTML });
  return Response.redirect(result.redirect, 303);
}
