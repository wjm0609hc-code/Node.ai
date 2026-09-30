// Handles Stripe webhooks. Events only say "look again": the handler re-reads the
// PaymentIntent or account from Stripe, so a replayed or out-of-order event is harmless.

import type { Logger } from "../lib/log";
import type { Payments } from "./payments";
import { verifyStripeWebhook } from "./stripe-gateway";

export interface StripeEventLike {
  type: string;
  account?: string;
  data: { object: { id?: string; object?: string } };
}

export async function handleStripeEvent(event: StripeEventLike, payments: Pick<Payments, "syncIntent" | "syncAccount">): Promise<void> {
  const obj = event.data.object;
  if (event.type.startsWith("payment_intent.") && obj.id) return payments.syncIntent(obj.id);
  if (event.type === "account.updated" && obj.id) return payments.syncAccount(obj.id);
}

export function createStripeWebhookRoute(deps: {
  payments: Pick<Payments, "syncIntent" | "syncAccount"> | null;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  verify?: (body: string, signature: string) => StripeEventLike;
}) {
  const env = deps.env ?? process.env;
  const verify =
    deps.verify ??
    ((body: string, signature: string) => verifyStripeWebhook(env.STRIPE_SECRET_KEY ?? "", body, signature, env.STRIPE_WEBHOOK_SECRET ?? "") as unknown as StripeEventLike);
  return async function POST(req: Request): Promise<Response> {
    if (!deps.payments) return new Response("payments not configured", { status: 404 });
    const body = await req.text();
    let event: StripeEventLike;
    try {
      event = verify(body, req.headers.get("stripe-signature") ?? "");
    } catch {
      deps.logger.warn("stripe.webhook_bad_signature", {});
      return new Response("bad signature", { status: 400 });
    }
    try {
      await handleStripeEvent(event, deps.payments);
    } catch (err) {
      // 500 makes Stripe retry later.
      deps.logger.error("stripe.webhook_failed", { type: event.type, error: (err as Error).name });
      return new Response("error", { status: 500 });
    }
    return new Response("ok");
  };
}
