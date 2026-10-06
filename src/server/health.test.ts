import { describe, expect, it } from "vitest";
import { checkConfig, checkDatabase, summarize } from "./health";

const good = {
  DATABASE_URL: "postgres://u:p@db.example.supabase.co:6543/postgres",
  NOD_APP_URL: "https://nod.example.com",
  SENDBLUE_API_KEY_ID: "kid",
  SENDBLUE_API_SECRET_KEY: "secret",
  SENDBLUE_FROM_NUMBER: "+15550100000",
  SENDBLUE_WEBHOOK_SECRET: "a".repeat(32),
  ANTHROPIC_API_KEY: "sk-ant-xyz",
  INNGEST_EVENT_KEY: "evt",
  INNGEST_SIGNING_KEY: "signkey-prod-abc",
  NOD_TIMEZONE: "America/New_York",
};

describe("checkConfig", () => {
  it("passes a complete setup and reports payments as off without Stripe", () => {
    const checks = checkConfig(good);
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.find((c) => c.name === "Payments")).toMatchObject({ status: "off" });
    expect(checks.find((c) => c.name === "Affiliate links")).toMatchObject({ status: "off" });
    expect(summarize(checks).ok).toBe(true);
  });

  it("names the affiliate programs that are set up", () => {
    const checks = checkConfig({ ...good, NOD_AFFILIATE_BOOKING: "123", NOD_AFFILIATE_VIATOR: "P1" });
    expect(checks.find((c) => c.name === "Affiliate links")).toMatchObject({ status: "ok", detail: "Booking.com, Viator." });
  });

  it("flags what's missing or malformed, without echoing secret values", () => {
    const checks = checkConfig({ ...good, SENDBLUE_FROM_NUMBER: "555-0100", NOD_APP_URL: "http://nod.example.com/", SENDBLUE_WEBHOOK_SECRET: "short", ANTHROPIC_API_KEY: "", NOD_TIMEZONE: "Mars/Olympus" });
    const failed = Object.fromEntries(checks.filter((c) => c.status === "fail").map((c) => [c.name, c.detail]));
    expect(Object.keys(failed).sort()).toEqual(["ANTHROPIC_API_KEY", "NOD_APP_URL", "NOD_TIMEZONE", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"]);
    expect(JSON.stringify(checks)).not.toContain("short");
    expect(JSON.stringify(checks)).not.toContain("secret");
    expect(summarize(checks).ok).toBe(false);
  });

  it("checks Stripe keys belong together and says which mode", () => {
    const test = checkConfig({ ...good, STRIPE_SECRET_KEY: "sk_test_1", STRIPE_PUBLISHABLE_KEY: "pk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_1" });
    expect(test.find((c) => c.name === "Payments")).toMatchObject({ status: "ok", detail: expect.stringMatching(/test mode/) });
    const mixed = checkConfig({ ...good, STRIPE_SECRET_KEY: "sk_live_1", STRIPE_PUBLISHABLE_KEY: "pk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_1" });
    expect(mixed.find((c) => c.name === "Payments")).toMatchObject({ status: "fail", detail: expect.stringMatching(/same mode/) });
    const noHook = checkConfig({ ...good, STRIPE_SECRET_KEY: "sk_test_1", STRIPE_PUBLISHABLE_KEY: "pk_test_1" });
    expect(noHook.find((c) => c.name === "Payments")).toMatchObject({ status: "fail", detail: expect.stringMatching(/STRIPE_WEBHOOK_SECRET/) });
  });

  it("requires the Inngest signing key", () => {
    expect(checkConfig({ ...good, INNGEST_SIGNING_KEY: "" }).find((c) => c.name === "INNGEST_SIGNING_KEY")?.status).toBe("fail");
  });
});

describe("checkDatabase", () => {
  it("reports a reachable, fully migrated database", async () => {
    const r = await checkDatabase({ ping: async () => {}, appliedMigrations: async () => 1 }, 1);
    expect(r).toMatchObject({ status: "ok" });
  });

  it("fails when migrations are behind or the database is unreachable", async () => {
    expect(await checkDatabase({ ping: async () => {}, appliedMigrations: async () => 0 }, 2)).toMatchObject({ status: "fail", detail: expect.stringMatching(/0 of 2.*npm run db:migrate/) });
    expect(await checkDatabase({ ping: async () => { throw new Error("ECONNREFUSED 10.0.0.1"); }, appliedMigrations: async () => 0 }, 1)).toMatchObject({ status: "fail", detail: "Can't connect." });
  });
});

describe("/api/health", () => {
  it("says ok or not publicly, and lists the checks only with the token", async () => {
    const { createHealthRoute } = await import("./health-route");
    const { createTestDb } = await import("../db/testing");
    const testDb = await createTestDb();
    const route = createHealthRoute({ env: { ...good, HEALTH_TOKEN: "t".repeat(20) }, db: async () => testDb });
    const pub = await route(new Request("https://nod.test/api/health"));
    expect(pub.status).toBe(200);
    expect(await pub.json()).toEqual({ ok: true });
    const full = await route(new Request("https://nod.test/api/health", { headers: { authorization: `Bearer ${"t".repeat(20)}` } }));
    const body = await full.json();
    expect(body.checks[0]).toMatchObject({ name: "Database", status: "ok" });
    expect(JSON.stringify(body)).not.toContain(good.ANTHROPIC_API_KEY);
    const wrong = await route(new Request("https://nod.test/api/health?token=nope"));
    expect(await wrong.json()).toEqual({ ok: true });
  }, 30_000); // starting an in-process Postgres is slow when the whole suite runs at once

  it("returns 503 when something required is missing or the database is down", async () => {
    const { createHealthRoute } = await import("./health-route");
    const route = createHealthRoute({ env: { ...good, ANTHROPIC_API_KEY: "" }, db: async () => { throw new Error("down"); } });
    const res = await route(new Request("https://nod.test/api/health"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });
});
