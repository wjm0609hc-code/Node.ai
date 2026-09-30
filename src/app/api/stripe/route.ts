// Stripe Connect webhook: PaymentIntent and account updates from payees' accounts.
// The signature is checked first; each event just triggers a re-read from Stripe.
import { createStripeWebhookRoute } from "../../../payments/webhook";
import { getContainer } from "../../../server/container";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { nod, logger } = await getContainer();
  return createStripeWebhookRoute({ payments: nod.payments, logger })(req);
}
