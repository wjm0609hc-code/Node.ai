import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../db/memory-store";
import { silentLogger } from "../lib/log";
import { cleanName, createWebSignup, SIGNUP_LIMITS } from "./signup";

function setup() {
  let current = new Date("2026-11-03T15:00:00Z");
  const store = new MemoryStore({ now: () => current });
  const signUp = vi.fn(async () => {});
  const web = createWebSignup({ store, signUp, salt: "s", logger: silentLogger, now: () => current });
  return { store, signUp, web, advance: (ms: number) => (current = new Date(current.getTime() + ms)) };
}

describe("home-page sign-up", () => {
  it("texts the number it's given, with the first name", async () => {
    const ctx = setup();
    expect(await ctx.web.handle({ name: "  will smith ", phone: "(617) 555-0123" }, "1.2.3.4")).toEqual({ status: "sent", phone: "+16175550123" });
    expect(ctx.signUp).toHaveBeenCalledWith({ phone: "+16175550123", name: "Will" });
  });

  it("refuses numbers it can't read", async () => {
    const ctx = setup();
    expect(await ctx.web.handle({ phone: "555-0123" }, "1.2.3.4")).toEqual({ status: "invalid_phone" });
    expect(ctx.signUp).not.toHaveBeenCalled();
  });

  it("texts each number at most once a day, but always says to check texts", async () => {
    const ctx = setup();
    await ctx.web.handle({ phone: "6175550123" }, "1.2.3.4");
    expect(await ctx.web.handle({ phone: "6175550123" }, "5.6.7.8")).toEqual({ status: "sent", phone: "+16175550123" });
    expect(ctx.signUp).toHaveBeenCalledTimes(1);
    ctx.advance(25 * 3_600_000);
    await ctx.web.handle({ phone: "6175550123" }, "5.6.7.8");
    expect(ctx.signUp).toHaveBeenCalledTimes(2);
  });

  it("limits how many numbers one network can sign up in an hour", async () => {
    const ctx = setup();
    for (let i = 0; i < SIGNUP_LIMITS.perNetworkPerHour; i++) await ctx.web.handle({ phone: `617555010${i}` }, "1.2.3.4");
    expect(await ctx.web.handle({ phone: "6175550199" }, "1.2.3.4")).toEqual({ status: "busy" });
    expect(await ctx.web.handle({ phone: "6175550199" }, "9.9.9.9")).toMatchObject({ status: "sent" });
    expect(ctx.signUp).toHaveBeenCalledTimes(SIGNUP_LIMITS.perNetworkPerHour + 1);
  });

  it("texts nobody when the hidden field is filled in", async () => {
    const ctx = setup();
    expect(await ctx.web.handle({ phone: "6175550123", website: "spam.example" }, "1.2.3.4")).toMatchObject({ status: "sent" });
    expect(ctx.signUp).not.toHaveBeenCalled();
  });
});

describe("cleanName", () => {
  it.each([["will", "Will"], ["Zoë", "Zoë"], ["<b>", "B"], ["  ", null], ["123", null]] as const)("%j → %j", (raw, name) => {
    expect(cleanName(raw)).toBe(name);
  });
});
