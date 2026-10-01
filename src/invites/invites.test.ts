import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import type { AddressedCall } from "../inbound/pipeline";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import { createNod } from "../nod";
import { inviteCopy, INVITES_PER_PERSON } from "./invites";

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });
type Scripted = ReturnType<typeof reply>;
const call = (name: string, input: Record<string, unknown>, after = "Done."): Scripted[] => [
  reply([toolUse("t", name, input)], "tool_use"),
  reply(after ? [text(after)] : []),
];

const DAY = 86_400_000;

function setup(opts: { responses?: Scripted[]; access?: "active" | "waitlist"; useClaude?: boolean } = {}) {
  let current = new Date("2026-09-29T15:00:00Z");
  const now = () => current;
  const world = new ChatWorld({ now });
  const store = new MemoryStore({ now });
  const responses = opts.responses ?? [];
  const requests: any[] = [];
  const create = vi.fn(async (body: any) => {
    requests.push(structuredClone(body));
    return responses.shift() ?? reply([text("ok")]);
  });
  const respond = vi.fn(async (_call: AddressedCall) => {});
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4", appUrl: "https://nod.test", timezone: "America/New_York" },
    now,
    ...(opts.useClaude
      ? { makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }) }
      : { respond }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  const ava = world.addUser({ name: "Ava", platform: "iphone" }); // knows nobody here yet
  const ready = registerWorldPeople(world, store, { access: opts.access ?? "active" }).then(async () => {
    await store.setUserAccess((await store.upsertUser(ava.phone)).id, "waitlist");
  });
  const userOf = (id: string) => store.upsertUser(world.user(id).phone);
  const dm = async (id: string, message: string) => {
    world.dm(id, message);
    await world.settled();
  };
  const dms = (id: string) => world.dmTranscript(id).filter((l) => l.from === "nod").map((l) => l.text);
  const lastDm = (id: string) => dms(id).at(-1);
  const advance = (ms: number) => {
    current = new Date(current.getTime() + ms);
  };
  const lastToolResult = () => {
    const msgs = requests.at(-1).messages;
    return msgs[msgs.length - 1].content[0].content as string;
  };
  return { world, store, nod, s, ava, ready, userOf, dm, dms, lastDm, advance, respond, lastToolResult, now };
}

describe("the text-based waitlist", () => {
  it("puts a stranger on the waitlist the first time they text, and doesn't hand them to Claude", async () => {
    const ctx = setup();
    await ctx.ready;
    await ctx.dm(ctx.ava.id, "hi what is this");
    expect(ctx.dms(ctx.ava.id)).toEqual([inviteCopy.waitlistJoined]);
    expect(await ctx.store.waitlistEntry(ctx.ava.phone)).toBeTruthy();
    await ctx.dm(ctx.ava.id, "hello?");
    expect(ctx.lastDm(ctx.ava.id)).toBe(inviteCopy.stillWaiting);
    expect(ctx.respond).not.toHaveBeenCalled();
  });

  it("lets group members without access keep using Nod privately (rule 6)", async () => {
    const ctx = setup({ access: "waitlist" });
    await ctx.ready;
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    await ctx.dm(ctx.s.users.jake.id, "2");
    expect(ctx.respond).toHaveBeenCalledTimes(1);
    expect(ctx.dms(ctx.s.users.jake.id)).toEqual([]);
  });

  it("waitlists whoever adds Nod without access, and tells them privately", async () => {
    const ctx = setup({ access: "waitlist" });
    await ctx.ready;
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    expect(await ctx.store.waitlistEntry(ctx.s.users.sarah.phone)).toBeTruthy();
    expect(ctx.lastDm(ctx.s.users.sarah.id)).toMatch(/I've put you on the waitlist/);
  });

  it("lets the next people in, oldest first, with the welcome", async () => {
    const ctx = setup();
    await ctx.ready;
    await ctx.dm(ctx.ava.id, "hi");
    const bo = ctx.world.addUser({ name: "Bo", platform: "iphone" });
    ctx.advance(60_000);
    await ctx.dm(bo.id, "hi");
    expect(await ctx.nod.invites.releaseWaitlist(1)).toBe(1);
    await ctx.world.settled();
    expect((await ctx.userOf(ctx.ava.id)).accessStatus).toBe("active");
    expect((await ctx.userOf(bo.id)).accessStatus).toBe("waitlist");
    expect(ctx.dms(ctx.ava.id).at(-3)).toMatch(/^A spot opened up, so you're in\. .*You have 3 invites/);
    expect(await ctx.store.waitlistEntry(ctx.ava.phone)).toBeUndefined();
  });
});

describe("redeeming a code", () => {
  it("gives access, invites and the welcome, and tells whoever shared it", async () => {
    const ctx = setup({ useClaude: true, responses: call("get_invite", {}, "") });
    await ctx.ready;
    await ctx.store.setInvitesRemaining((await ctx.userOf(ctx.s.users.will.id)).id, 1);
    await ctx.dm(ctx.s.users.will.id, "can I get an invite for a friend?");
    const code = /NOD-[A-Z0-9]{6}/.exec(ctx.dms(ctx.s.users.will.id).at(-1)!)![0];
    const before = ctx.dms(ctx.s.users.will.id).length;

    await ctx.dm(ctx.ava.id, `hey, my code is ${code.toLowerCase()}`);
    const ava = await ctx.userOf(ctx.ava.id);
    expect(ava).toMatchObject({ accessStatus: "active", invitesRemaining: INVITES_PER_PERSON });
    const welcome = ctx.world.dmTranscript(ctx.ava.id).filter((l) => l.from === "nod");
    expect(welcome).toHaveLength(3);
    expect(welcome[0]!.text).toMatch(/^You're in\. I help group chats/);
    expect(welcome[0]!.contactCard?.name).toBe("Nod");
    expect(welcome[1]!.mediaUrls).toEqual(["https://nod.test/v.mp4"]);
    expect(welcome[2]!.text).toMatch(/^Privacy:/);
    expect(ctx.dms(ctx.s.users.will.id).slice(before)).toEqual(["Ava just joined with your invite."]);
  });

  it("refuses a used or unknown code, and stops guessing after five wrong codes a day", async () => {
    const ctx = setup();
    await ctx.ready;
    const [code] = await ctx.nod.invites.createCodes(1);
    const bo = ctx.world.addUser({ name: "Bo", platform: "iphone" });
    await ctx.store.upsertUser(bo.phone);
    await ctx.dm(bo.id, code!);
    await ctx.dm(ctx.ava.id, code!);
    expect(ctx.lastDm(ctx.ava.id)).toBe(inviteCopy.codeUsed);
    for (let i = 0; i < 4; i++) await ctx.dm(ctx.ava.id, "NOD-2345AB");
    expect(ctx.lastDm(ctx.ava.id)).toBe(inviteCopy.codeUnknown);
    const [fresh] = await ctx.nod.invites.createCodes(1);
    await ctx.dm(ctx.ava.id, fresh!);
    expect(ctx.lastDm(ctx.ava.id)).toBe(inviteCopy.tooManyTries);
    expect((await ctx.userOf(ctx.ava.id)).accessStatus).toBe("waitlist");
    ctx.advance(DAY + 1000);
    await ctx.dm(ctx.ava.id, fresh!);
    expect((await ctx.userOf(ctx.ava.id)).accessStatus).toBe("active");
  });

  it("tells someone who already has access to keep the code, without using it", async () => {
    const ctx = setup();
    await ctx.ready;
    const [code] = await ctx.nod.invites.createCodes(1);
    await ctx.dm(ctx.s.users.will.id, code!);
    expect(ctx.lastDm(ctx.s.users.will.id)).toBe(inviteCopy.alreadyIn);
    expect((await ctx.store.inviteByCode(code!))?.redeemedAt).toBeNull();
    expect(ctx.respond).not.toHaveBeenCalled();
  });

  it("then lets them add Nod to a group without the access note", async () => {
    const ctx = setup({ access: "waitlist" });
    await ctx.ready;
    const [code] = await ctx.nod.invites.createCodes(1);
    await ctx.dm(ctx.s.users.sarah.id, code!);
    const count = ctx.dms(ctx.s.users.sarah.id).length;
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    expect(ctx.dms(ctx.s.users.sarah.id)).toHaveLength(count);
  });
});

describe("get_invite", () => {
  it("sends the code privately, counts down, and stops at zero", async () => {
    const ctx = setup({ useClaude: true, responses: [...call("get_invite", {}, "Sent you one privately."), ...call("get_invite", {}), ...call("get_invite", {}), ...call("get_invite", {})] });
    await ctx.ready;
    await ctx.store.setInvitesRemaining((await ctx.userOf(ctx.s.users.will.id)).id, 3);
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    const ask = async () => {
      ctx.world.say(ctx.s.users.will.id, ctx.s.groupId, "@Nod can I get an invite code?", { mentionNod: true });
      await ctx.world.settled();
    };
    await ask();
    expect(ctx.lastToolResult()).toBe("Sent Will a code privately (2 left).");
    expect(ctx.lastDm(ctx.s.users.will.id)).toMatch(/^Here's an invite for a friend: NOD-[A-Z0-9]{6}\. They text it to me, or open https:\/\/nod\.test\/join\?code=NOD-[A-Z0-9]{6}\. You have 2 left\.$/);
    const groupText = ctx.world.transcript(ctx.s.groupId, ctx.s.users.will.id).map((l) => l.text).join("\n");
    expect(groupText).not.toMatch(/NOD-[A-Z0-9]{6}/);
    await ask();
    await ask();
    expect(ctx.lastDm(ctx.s.users.will.id)).toMatch(/That was your last one\.$/);
    await ask();
    expect(ctx.lastToolResult()).toBe("Will has used all their invites.");
  });

  it("puts someone without access on the waitlist instead", async () => {
    const ctx = setup({ access: "waitlist", useClaude: true, responses: call("get_invite", {}) });
    await ctx.ready;
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    ctx.world.say(ctx.s.users.jake.id, ctx.s.groupId, "@Nod how do I get this for my other chats?", { mentionNod: true });
    await ctx.world.settled();
    expect(ctx.lastToolResult()).toMatch(/^Jake doesn't have access yet.*on the waitlist/);
    expect(await ctx.store.waitlistEntry(ctx.s.users.jake.phone)).toBeTruthy();
  });
});

describe("post-trip codes", () => {
  async function tripSetup() {
    const ctx = setup();
    await ctx.ready;
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    const group = (await ctx.store.groupByProviderId("simulator", ctx.s.groupId))!;
    const event = (startsAt: string, endsAt: string, allDay = true) =>
      ctx.store.createEvent({ groupId: group.id, bookingId: null, title: "Trip", startsAt: new Date(startsAt), endsAt: new Date(endsAt), allDay, location: null, description: null });
    return { ...ctx, group, event };
  }

  it("sends each member one code the day after a multi-day trip, once", async () => {
    const ctx = await tripSetup();
    await ctx.event("2026-09-24T00:00:00Z", "2026-09-29T00:00:00Z"); // Sep 24–28
    expect(await ctx.nod.invites.sweepTrips()).toBe(4);
    await ctx.world.settled();
    expect(ctx.lastDm(ctx.s.users.mike.id)).toMatch(/^Hope Tulum 🌴 was great\. Here's an invite to pass on to a friend: NOD-[A-Z0-9]{6} \(https:\/\/nod\.test\/join\?code=NOD-[A-Z0-9]{6}\)\.$/);
    expect(await ctx.nod.invites.sweepTrips()).toBe(0);
    const codes = await ctx.store.unredeemedInvites((await ctx.userOf(ctx.s.users.mike.id)).id, "post_trip");
    expect(codes).toHaveLength(1);
  });

  it("tells members without access they can use it themselves", async () => {
    const ctx = await tripSetup();
    await ctx.store.setUserAccess((await ctx.userOf(ctx.s.users.jake.id)).id, "waitlist");
    await ctx.event("2026-09-24T00:00:00Z", "2026-09-29T00:00:00Z");
    await ctx.nod.invites.sweepTrips();
    await ctx.world.settled();
    expect(ctx.lastDm(ctx.s.users.jake.id)).toMatch(/Text it back to me to add me to your own groups/);
  });

  it("skips one-day events, timed events, trips still going, and trips long past", async () => {
    const ctx = await tripSetup();
    await ctx.event("2026-09-28T00:00:00Z", "2026-09-29T00:00:00Z"); // one day
    await ctx.event("2026-09-26T20:00:00Z", "2026-09-28T22:00:00Z", false); // timed
    await ctx.event("2026-09-27T00:00:00Z", "2026-10-02T00:00:00Z"); // still going
    await ctx.event("2026-09-10T00:00:00Z", "2026-09-20T00:00:00Z"); // ended over three days ago
    expect(await ctx.nod.invites.sweepTrips()).toBe(0);
  });

  it("skips members still holding an unused post-trip code", async () => {
    const ctx = await tripSetup();
    await ctx.event("2026-09-20T00:00:00Z", "2026-09-23T00:00:00Z");
    ctx.advance(-5 * DAY);
    expect(await ctx.nod.invites.sweepTrips()).toBe(4);
    ctx.advance(5 * DAY);
    await ctx.event("2026-09-25T00:00:00Z", "2026-09-29T00:00:00Z");
    expect(await ctx.nod.invites.sweepTrips()).toBe(0);
  });

  it("skips groups Nod was removed from", async () => {
    const ctx = await tripSetup();
    ctx.world.removeNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    await ctx.event("2026-09-26T00:00:00Z", "2026-09-29T00:00:00Z");
    expect(await ctx.nod.invites.sweepTrips()).toBe(0);
  });

  it("after a failed send, a rerun texts only the members still missing a code", async () => {
    const ctx = await tripSetup();
    await ctx.event("2026-09-24T00:00:00Z", "2026-09-29T00:00:00Z");
    const provider = ctx.nod.provider;
    const realSend = provider.send.bind(provider);
    let sends = 0;
    provider.send = async (to, content) => {
      if (content.text?.startsWith("Hope") && ++sends === 3) throw new Error("sendblue timeout");
      return realSend(to, content);
    };
    await expect(ctx.nod.invites.sweepTrips()).rejects.toThrow("sendblue timeout");
    provider.send = realSend;
    expect(await ctx.nod.invites.sweepTrips()).toBe(2);
    await ctx.world.settled();
    for (const who of ["will", "jake", "sarah", "mike"] as const) {
      expect(ctx.dms(ctx.s.users[who].id).filter((t) => t.startsWith("Hope"))).toHaveLength(1);
    }
    expect(await ctx.nod.invites.sweepTrips()).toBe(0);
  });
});
