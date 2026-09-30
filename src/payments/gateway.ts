// Card payments behind one interface: Stripe in production (stripe-gateway.ts),
// an in-memory fake in tests and the simulators (fake-gateway.ts).
//
// Money model (rules 4 and 5): each payer's card is authorized (held) on the
// payee's own Stripe Connect account as a direct charge, and captured only once
// everyone has paid and the spending rules are met. Funds settle straight to the
// payee; Nod's platform never holds them.

export type IntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

export interface Intent {
  id: string;
  status: IntentStatus;
  /** What can be captured now, in cents (0 until the card is held). */
  amountCapturable: number;
  clientSecret: string;
}

export interface PaymentGateway {
  /** For the pay page's Stripe.js. */
  publishableKey: string;
  createAccount(r: { phone: string; name: string | null }): Promise<{ accountId: string }>;
  onboardingLink(r: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string }>;
  accountReady(accountId: string): Promise<boolean>;
  /** A manual-capture PaymentIntent on the payee's account. */
  createHold(r: {
    accountId: string;
    amountCents: number;
    currency: string;
    description: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<Intent>;
  getIntent(r: { accountId: string; intentId: string }): Promise<Intent>;
  capture(r: { accountId: string; intentId: string; idempotencyKey: string }): Promise<void>;
  cancel(r: { accountId: string; intentId: string; idempotencyKey: string }): Promise<void>;
}

/** A declined capture or other card problem the payer can fix by paying again. */
export class CardError extends Error {
  constructor(readonly code: string) {
    super(`card error: ${code}`);
    this.name = "CardError";
  }
}

/** For setups without payments (most tests). */
export const noGateway: PaymentGateway = {
  publishableKey: "",
  async createAccount() {
    throw new Error("payments aren't set up here");
  },
  async onboardingLink() {
    throw new Error("payments aren't set up here");
  },
  async accountReady() {
    return false;
  },
  async createHold() {
    throw new Error("payments aren't set up here");
  },
  async getIntent() {
    throw new Error("payments aren't set up here");
  },
  async capture() {
    throw new Error("payments aren't set up here");
  },
  async cancel() {
    throw new Error("payments aren't set up here");
  },
};
