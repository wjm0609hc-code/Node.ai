// Stripe Connect behind PaymentGateway. Direct charges on the payee's connected
// account with capture_method "manual": the card is held when someone pays and
// charged once the group is fully funded. The SDK retries network errors and
// times out; every write carries an idempotency key.
//
// To verify against Stripe's Connect docs before launch: the account settings
// in createAccount (controller: who pays fees and bears losses for direct
// charges on these accounts, and which dashboard payees get).

import Stripe from "stripe";
import { CardError, type Intent, type PaymentGateway } from "./gateway";

export interface StripeGatewayConfig {
  secretKey: string;
  publishableKey: string;
  country?: string;
}

function toIntent(pi: Stripe.PaymentIntent): Intent {
  return { id: pi.id, status: pi.status as Intent["status"], amountCapturable: pi.amount_capturable, clientSecret: pi.client_secret ?? "" };
}

function rethrow(err: unknown): never {
  if (err instanceof Stripe.errors.StripeCardError) throw new CardError(err.code ?? "card_declined");
  throw err;
}

export function createStripeGateway(config: StripeGatewayConfig): PaymentGateway {
  const stripe = new Stripe(config.secretKey, { maxNetworkRetries: 2, timeout: 10_000 });
  return {
    publishableKey: config.publishableKey,

    async createAccount({ phone, name }) {
      const account = await stripe.accounts.create({
        country: config.country ?? "US",
        business_type: "individual",
        individual: { phone, ...(name ? { first_name: name.split(" ")[0] } : {}) },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        controller: {
          stripe_dashboard: { type: "express" },
          fees: { payer: "application" },
          losses: { payments: "application" },
          requirement_collection: "stripe",
        },
      });
      return { accountId: account.id };
    },

    async onboardingLink({ accountId, returnUrl, refreshUrl }) {
      const link = await stripe.accountLinks.create({ account: accountId, type: "account_onboarding", return_url: returnUrl, refresh_url: refreshUrl });
      return { url: link.url };
    },

    async accountReady(accountId) {
      const account = await stripe.accounts.retrieve(accountId);
      return account.charges_enabled === true;
    },

    async createHold({ accountId, amountCents, currency, description, metadata, idempotencyKey }) {
      const pi = await stripe.paymentIntents.create(
        {
          amount: amountCents,
          currency: currency.toLowerCase(),
          capture_method: "manual",
          automatic_payment_methods: { enabled: true },
          description,
          metadata,
        },
        { stripeAccount: accountId, idempotencyKey },
      );
      return toIntent(pi);
    },

    async getIntent({ accountId, intentId }) {
      return toIntent(await stripe.paymentIntents.retrieve(intentId, {}, { stripeAccount: accountId }));
    },

    async capture({ accountId, intentId, idempotencyKey }) {
      try {
        await stripe.paymentIntents.capture(intentId, {}, { stripeAccount: accountId, idempotencyKey });
      } catch (err) {
        rethrow(err);
      }
    },

    async cancel({ accountId, intentId, idempotencyKey }) {
      await stripe.paymentIntents.cancel(intentId, {}, { stripeAccount: accountId, idempotencyKey });
    },
  };
}

/** Verifies a Stripe webhook's signature and returns the event. Throws if it doesn't verify. */
export function verifyStripeWebhook(secretKey: string, body: string, signature: string, webhookSecret: string): Stripe.Event {
  return new Stripe(secretKey).webhooks.constructEvent(body, signature, webhookSecret);
}
