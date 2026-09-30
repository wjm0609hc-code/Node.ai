import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../lib/log";
import { createStripeWebhookRoute, handleStripeEvent } from "./webhook";

const post = (body: string, sig = "t=1,v1=x") => new Request("https://nod.test/api/stripe", { method: "POST", body, headers: { "stripe-signature": sig } });

describe("Stripe webhook", () => {
  it("re-reads PaymentIntents and accounts it's told about", async () => {
    const payments = { syncIntent: vi.fn(async () => {}), syncAccount: vi.fn(async () => {}) };
    await handleStripeEvent({ type: "payment_intent.amount_capturable_updated", account: "acct_1", data: { object: { id: "pi_1" } } }, payments);
    await handleStripeEvent({ type: "account.updated", data: { object: { id: "acct_1" } } }, payments);
    await handleStripeEvent({ type: "charge.refunded", data: { object: { id: "ch_1" } } }, payments);
    expect(payments.syncIntent).toHaveBeenCalledWith("pi_1");
    expect(payments.syncAccount).toHaveBeenCalledWith("acct_1");
    expect(payments.syncIntent).toHaveBeenCalledTimes(1);
  });

  it("rejects a bad signature without touching anything", async () => {
    const payments = { syncIntent: vi.fn(async () => {}), syncAccount: vi.fn(async () => {}) };
    const route = createStripeWebhookRoute({ payments, logger: silentLogger, verify: () => { throw new Error("bad"); } });
    expect((await route(post("{}"))).status).toBe(400);
    expect(payments.syncIntent).not.toHaveBeenCalled();
  });

  it("returns 500 on failure so Stripe retries, and 200 when handled", async () => {
    const event = { type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } };
    const failing = createStripeWebhookRoute({
      payments: { syncIntent: async () => { throw new Error("db down"); }, syncAccount: async () => {} },
      logger: silentLogger,
      verify: () => event,
    });
    expect((await failing(post("{}"))).status).toBe(500);
    const ok = createStripeWebhookRoute({ payments: { syncIntent: async () => {}, syncAccount: async () => {} }, logger: silentLogger, verify: () => event });
    expect((await ok(post("{}"))).status).toBe(200);
  });

  it("verifies real Stripe signatures by default", async () => {
    const route = createStripeWebhookRoute({
      payments: { syncIntent: async () => {}, syncAccount: async () => {} },
      logger: silentLogger,
      env: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test" } as NodeJS.ProcessEnv,
    });
    expect((await route(post('{"type":"account.updated"}', "t=1,v1=forged"))).status).toBe(400);
  });
});
