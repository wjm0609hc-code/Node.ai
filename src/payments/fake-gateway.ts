// An in-memory stand-in for Stripe, for tests and the simulators. `authorize`
// plays the part of a payer entering a card on the pay page.

import { CardError, type Intent, type PaymentGateway } from "./gateway";

interface FakeIntent extends Intent {
  accountId: string;
  amountCents: number;
}

export class FakeGateway implements PaymentGateway {
  readonly publishableKey = "pk_test_sample";
  readonly intents = new Map<string, FakeIntent>();
  readonly captured: string[] = [];
  readonly cancelled: string[] = [];
  private readonly accounts = new Map<string, boolean>();
  private readonly keys = new Map<string, string>();
  private seq = 0;
  /** Intent ids whose next capture is declined. */
  readonly declineCapture = new Set<string>();

  async createAccount() {
    const accountId = `acct_sample_${++this.seq}`;
    this.accounts.set(accountId, false);
    return { accountId };
  }

  async onboardingLink({ accountId }: { accountId: string }) {
    return { url: `https://connect.sample/onboard/${accountId}` };
  }

  async accountReady(accountId: string) {
    return this.accounts.get(accountId) ?? false;
  }

  /** Finishes a payee's (sample) payout setup. */
  completeOnboarding(accountId: string): void {
    this.accounts.set(accountId, true);
  }

  async createHold(r: { accountId: string; amountCents: number; idempotencyKey: string }) {
    const known = this.keys.get(r.idempotencyKey);
    if (known) return { ...this.intents.get(known)! };
    const id = `pi_sample_${++this.seq}`;
    const intent: FakeIntent = { id, status: "requires_payment_method", amountCapturable: 0, clientSecret: `${id}_secret`, accountId: r.accountId, amountCents: r.amountCents };
    this.intents.set(id, intent);
    this.keys.set(r.idempotencyKey, id);
    return { ...intent };
  }

  async getIntent({ intentId }: { intentId: string }) {
    const i = this.intents.get(intentId);
    if (!i) throw new Error("no such intent");
    return { ...i };
  }

  /** The payer's card is held (what confirming on the pay page does). */
  authorize(intentId: string): void {
    const i = this.intents.get(intentId)!;
    i.status = "requires_capture";
    i.amountCapturable = i.amountCents;
  }

  /** The hold lapsed or was released outside Nod. */
  expire(intentId: string): void {
    const i = this.intents.get(intentId)!;
    i.status = "canceled";
    i.amountCapturable = 0;
  }

  async capture({ intentId }: { intentId: string }) {
    const i = this.intents.get(intentId)!;
    if (i.status === "succeeded") return;
    if (this.declineCapture.delete(intentId)) {
      i.status = "requires_payment_method";
      i.amountCapturable = 0;
      throw new CardError("card_declined");
    }
    if (i.status !== "requires_capture") throw new Error(`can't capture a ${i.status} intent`);
    i.status = "succeeded";
    i.amountCapturable = 0;
    this.captured.push(intentId);
  }

  async cancel({ intentId }: { intentId: string }) {
    const i = this.intents.get(intentId);
    if (!i || i.status === "succeeded" || i.status === "canceled") return;
    i.status = "canceled";
    i.amountCapturable = 0;
    this.cancelled.push(intentId);
  }
}
