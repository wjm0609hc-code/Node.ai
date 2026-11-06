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

function setup(opts: { responses?: Scripted[]; access?: "active" | "waitlist"; useClaude?: boolean; groupSignup?: "access" | "waitlist" } = {}) {
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
    config: { howToVideoUrl: "https://nod.test/v.mp4", appUrl: "https://nod.test", timezone: "America/New_York", groupSignup: opts.groupSignup },
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
    expect(ctx.dms(ctx.ava.id)).toEqual(inviteCopy.waitlistJoined("Ava"));
    expect(await ctx.store.waitlistEntry(ctx.ava.phone)).toBeTruthy();
    await ctx.dm(ctx.ava.id, "hello?");
    expect(ctx.lastDm(ctx.ava.id)).toBe(inviteCopy.stillWaiting);
    expect(ctx.respond).not.toHaveBeenCalled();
  });

  it("greets by the name someone gives, and says just Hey without one", async () => {
    expect(inviteCopy.waitlistJoined(null)[0]).toMatch(/^Hey! /);
    const ctx = setup();
    await ctx.ready;
    const stranger = ctx.world.addUser({ name: "Avery", platform: "iphone" }); // Nod doesn't know the name
    await ctx.dm(stranger.id, "Hey Nod! I'm Avery.");
    expect(ctx.dms(stranger.id)).toEqual(inviteCopy.waitlistJoined("Avery"));
    expect((await ctx.store.upsertUser(stranger.phone)).name).toBe("Avery");
    const quiet = ctx.world.addUser({ name: "Quinn", platform: "iphone" });
    await ctx.dm(quiet.id, "hi what is this");
    expect(ctx.dms(quiet.id)).toEqual(inviteCopy.waitlistJoined(null));
  });

  it("with group sign-up off, lets group members without access keep using Nod privately (rule 6)", async () => {
    const ctx = setup({ access: "waitlist", groupSignup: "waitlist" });
    await ctx.ready;
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    await ctx.dm(ctx.s.users.jake.id, "2");
    expect(ctx.respond).toHaveBeenCalledTimes(1);
    expect(ctx.dms(ctx.s.users.jake.id)).toEqual([]);
  });

  it("with group sign-up off, waitlists whoever adds Nod without access, and tells them privately", async () => {
    const ctx = setup({ access: "waitlist", groupSignup: "waitlist" });
    await ctx.ready;
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    expect(await ctx.store.waitlistEntry(ctx.s.users.sarah.phone)).toBeTruthy();
    expect(ctx.lastDm(ctx.s.users.sarah.id)).toMatch(/you're on the waitlist and I'll text you/);
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
    expect(ctx.dms(ctx.ava.id).at(-3)).toMatch(/^A spot opened up, so you're in\. .*You've got 3 invites/);
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
    expect(welcome[0]!.text).toMatch(/^You're in\. I'm the AI agent for your group chats/);
    expect(welcome[0]!.contactCard?.name).toBe("Nod");
    expect(welcome[1]!.mediaUrls).toEqual(["https://nod.test/v.mp4"]);
    expect(welcome[2]!.text).toMatch(/^On privacy:/);
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
    expect(ctx.lastDm(ctx.s.users.will.id)).toMatch(/^Here's an invite for a friend: NOD-[A-Z0-9]{6}\. They can text it to me or open https:\/\/nod\.test\/join\?code=NOD-[A-Z0-9]{6}\. You have 2 left\.$/);
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
    expect(ctx.lastDm(ctx.s.users.mike.id)).toMatch(/^Hope Tulum 🌴 was a great trip\. Here's an invite to pass on to a friend: NOD-[A-Z0-9]{6} \(https:\/\/nod\.test\/join\?code=NOD-[A-Z0-9]{6}\)\.$/);
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
    expect(ctx.lastDm(ctx.s.users.jake.id)).toMatch(/Text it back to me to use me in your own groups/);
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

describe("signing up from a group", () => {
  const introOf = (ctx: ReturnType<typeof setup>) =>
    ctx.world.transcript(ctx.s.groupId, ctx.s.users.will.id).find((l) => l.from === "nod" && l.text.includes("Tap ❤️ on this"))!;
  const inGroup = async (opts: Parameters<typeof setup>[0] = {}) => {
    const ctx = setup({ access: "waitlist", ...opts });
    await ctx.ready;
    const sarah = await ctx.userOf(ctx.s.users.sarah.id);
    await ctx.store.setUserAccess(sarah.id, "active"); // Sarah has access and adds Nod
    await ctx.store.claimSetup(sarah.id);
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    return ctx;
  };

  it("the introduction asks people to tap ❤️ for their own Nod", async () => {
    const ctx = await inGroup();
    expect(introOf(ctx).text).toMatch(/Tap ❤️ on this for me in your own chats\.$/);
  });

  it("a ❤️ or 👍 on the introduction gets that person in, privately, with the setup and contact card", async () => {
    const ctx = await inGroup();
    ctx.world.react(ctx.s.users.jake.id, introOf(ctx).messageId, "love");
    ctx.world.react(ctx.s.users.mike.id, introOf(ctx).messageId, "like");
    await ctx.world.settled();
    for (const who of [ctx.s.users.jake, ctx.s.users.mike]) {
      expect((await ctx.userOf(who.id)).accessStatus).toBe("active");
      const lines = ctx.world.dmTranscript(who.id).filter((l) => l.from === "nod");
      expect(lines).toHaveLength(3);
      expect(lines[0]!.text).toMatch(/^You're in\. .*Save my card/);
      expect(lines[0]!.contactCard?.name).toBe("Nod");
      expect(lines[1]!.mediaUrls).toEqual(["https://nod.test/v.mp4"]);
    }
    // nothing in the group (rule 1), and Claude wasn't asked
    expect(ctx.world.transcript(ctx.s.groupId, ctx.s.users.will.id).filter((l) => l.from === "nod")).toHaveLength(1);
    expect(ctx.respond).not.toHaveBeenCalled();
  });

  it("ignores removed tapbacks, 👎, tapbacks on Nod's other messages, and people already set up", async () => {
    const ctx = await inGroup();
    const intro = introOf(ctx).messageId;
    ctx.world.react(ctx.s.users.jake.id, intro, "dislike");
    ctx.world.react(ctx.s.users.mike.id, intro, "love", { removed: true });
    ctx.world.react(ctx.s.users.sarah.id, intro, "love"); // already in, setup already sent
    await ctx.world.settled();
    for (const who of ["jake", "mike", "sarah"] as const) expect(ctx.dms(ctx.s.users[who].id)).toEqual([]);
    expect((await ctx.userOf(ctx.s.users.jake.id)).accessStatus).toBe("waitlist");
  });

  it("counts the SMS form of the tapback in mixed groups", async () => {
    const ctx = setup({ access: "waitlist" });
    await ctx.ready;
    const priya = ctx.world.addUser({ name: "Priya", platform: "android" });
    const will = await ctx.userOf(ctx.s.users.will.id);
    await ctx.store.setUserAccess(will.id, "active");
    await ctx.store.claimSetup(will.id);
    await ctx.dm(ctx.s.users.will.id, `start a group for Brunch with ${priya.phone} and ${ctx.s.users.jake.phone}`);
    const groupId = ctx.world.allGroups().find((g) => g.hasNod && g.name === "Brunch")!.id;
    expect(ctx.world.groupService(groupId)).toBe("sms");
    ctx.world.say(priya.id, groupId, `Loved “Will asked me to start this group. Tag @Nod when you need me. I stay quiet otherwise…”`);
    await ctx.world.settled();
    expect((await ctx.store.upsertUser(priya.phone)).accessStatus).toBe("active");
    expect(ctx.dms(priya.id)[0]).toMatch(/^You're in\./);
  });

  it("texting Nod privately from a group gets you in; a plain hello gets just the welcome", async () => {
    const ctx = await inGroup();
    await ctx.dm(ctx.s.users.jake.id, "hey nod");
    expect((await ctx.userOf(ctx.s.users.jake.id)).accessStatus).toBe("active");
    expect(ctx.dms(ctx.s.users.jake.id)).toHaveLength(3);
    expect(ctx.respond).not.toHaveBeenCalled();
  });

  it("a real question from a group member gets the welcome and then an answer (rule 6)", async () => {
    const ctx = await inGroup();
    await ctx.dm(ctx.s.users.jake.id, "2");
    expect(ctx.dms(ctx.s.users.jake.id)[0]).toMatch(/^You're in\./);
    expect(ctx.respond).toHaveBeenCalledTimes(1);
  });

  it("whoever adds Nod without access is set up right away", async () => {
    const ctx = setup({ access: "waitlist" });
    await ctx.ready;
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    expect((await ctx.userOf(ctx.s.users.sarah.id)).accessStatus).toBe("active");
    expect(ctx.dms(ctx.s.users.sarah.id)[0]).toMatch(/^Thanks for adding me to Tulum 🌴\. You're all set to use me in any chat\./);
    expect(await ctx.store.waitlistEntry(ctx.s.users.sarah.phone)).toBeUndefined();
  });

  it("with group sign-up off, the tapback joins the waitlist instead", async () => {
    const ctx = await inGroup({ groupSignup: "waitlist" });
    ctx.world.react(ctx.s.users.jake.id, introOf(ctx).messageId, "love");
    await ctx.world.settled();
    expect((await ctx.userOf(ctx.s.users.jake.id)).accessStatus).toBe("waitlist");
    expect((await ctx.store.waitlistEntry(ctx.s.users.jake.phone))?.source).toBe("group");
    expect(ctx.dms(ctx.s.users.jake.id)).toEqual(inviteCopy.waitlistJoined("Jake"));
  });
});

describe("signing up on the home page", () => {
  it("texts a new person the two waitlist texts by name, with a way to opt out", async () => {
    const ctx = setup();
    await ctx.ready;
    const zoe = ctx.world.addUser({ name: "Zoe", platform: "iphone" });
    await ctx.nod.invites.signUpFromWeb({ phone: zoe.phone, name: "Zoe" });
    await ctx.world.settled();
    const [welcome, skip] = inviteCopy.waitlistJoined("Zoe");
    expect(ctx.dms(zoe.id)).toEqual([welcome, skip + inviteCopy.optOut]);
    expect((await ctx.store.waitlistEntry(zoe.phone))?.source).toBe("web");
    expect((await ctx.store.upsertUser(zoe.phone)).name).toBe("Zoe");
    await ctx.nod.invites.signUpFromWeb({ phone: zoe.phone, name: "Zoe" });
    expect(ctx.lastDm(zoe.id)).toBe(inviteCopy.stillWaiting + inviteCopy.optOut);
  });

  it("never renames someone Nod already knows", async () => {
    const ctx = setup();
    await ctx.ready;
    await ctx.nod.invites.signUpFromWeb({ phone: ctx.ava.phone, name: "Not Ava" });
    expect((await ctx.userOf(ctx.ava.id)).name).toBe("Ava");
  });

  it("tells people who are already in, and lets group members straight in", async () => {
    const ctx = setup({ access: "waitlist" });
    await ctx.ready;
    const will = await ctx.userOf(ctx.s.users.will.id);
    await ctx.store.setUserAccess(will.id, "active");
    await ctx.nod.invites.signUpFromWeb({ phone: will.phone });
    expect(ctx.lastDm(ctx.s.users.will.id)).toBe(inviteCopy.alreadyInWeb);

    ctx.world.addNod(ctx.s.groupId, ctx.s.users.will.id);
    await ctx.world.settled();
    await ctx.nod.invites.signUpFromWeb({ phone: ctx.s.users.mike.phone });
    expect((await ctx.userOf(ctx.s.users.mike.id)).accessStatus).toBe("active");
    expect(ctx.dms(ctx.s.users.mike.id)[0]).toMatch(/^You're in\./);
  });
});

describe("STOP and START", () => {
  it("STOP sends one confirmation and then nothing private until START", async () => {
    const ctx = setup();
    await ctx.ready;
    await ctx.dm(ctx.ava.id, "hi");
    await ctx.dm(ctx.ava.id, "STOP");
    expect(ctx.lastDm(ctx.ava.id)).toBe(inviteCopy.stopped);
    const before = ctx.dms(ctx.ava.id).length;

    await ctx.dm(ctx.ava.id, "hello?");
    await ctx.nod.invites.signUpFromWeb({ phone: ctx.ava.phone, name: "Ava" });
    await ctx.nod.invites.releaseWaitlist(5);
    await ctx.world.settled();
    expect(ctx.dms(ctx.ava.id)).toHaveLength(before);

    await ctx.dm(ctx.ava.id, "Start");
    expect(ctx.lastDm(ctx.ava.id)).toBe(inviteCopy.started);
    expect(ctx.respond).not.toHaveBeenCalled();
  });

  it("answers HELP, even after STOP", async () => {
    const ctx = setup();
    await ctx.ready;
    await ctx.dm(ctx.ava.id, "HELP");
    expect(ctx.lastDm(ctx.ava.id)).toBe(inviteCopy.help(undefined, "https://nod.test"));
    expect(ctx.lastDm(ctx.ava.id)).toMatch(/Reply STOP to stop texts\.$/);
    await ctx.dm(ctx.ava.id, "stop");
    await ctx.dm(ctx.ava.id, "help");
    expect(ctx.lastDm(ctx.ava.id)).toMatch(/^Nod: an assistant for your group chats\. Help: https:\/\/nod\.test\/terms\./);
    expect(ctx.respond).not.toHaveBeenCalled();
  });

  it("only counts STOP as the whole message", async () => {
    const ctx = setup();
    await ctx.ready;
    await ctx.dm(ctx.ava.id, "don't stop me now");
    expect(ctx.lastDm(ctx.ava.id)).not.toBe(inviteCopy.stopped);
  });
});

describe("asking people's names", () => {
  it("asks once in the private welcome, and the next short reply becomes their name everywhere", async () => {
    const ctx = setup({ access: "waitlist" });
    await ctx.ready;
    const sarah = await ctx.userOf(ctx.s.users.sarah.id);
    await ctx.store.setUserAccess(sarah.id, "active");
    await ctx.store.claimSetup(sarah.id);
    ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
    await ctx.world.settled();
    const stranger = ctx.world.addUser({ name: "Brian", platform: "iphone", phone: "+16175556249" });
    // Brian, whom Nod knows only by number, signs up (as a tap on the intro would).
    await ctx.nod.invites.signUpFromGroup(await ctx.store.upsertUser(stranger.phone));
    await ctx.world.settled();
    expect(ctx.dms(stranger.id).at(-1)).toMatch(/what should I call you\?$/);

    await ctx.dm(stranger.id, "brian");
    expect(ctx.lastDm(stranger.id)).toBe("Nice to meet you, Brian. I'll use that in every chat we share.");
    expect((await ctx.store.upsertUser(stranger.phone)).name).toBe("Brian");
    expect(ctx.respond).not.toHaveBeenCalled();

    // After that, a real question goes through as usual.
    await ctx.dm(stranger.id, "what's on the tab?");
    expect(ctx.respond).toHaveBeenCalledTimes(1);
  });

  it("doesn't ask people Nod already knows, and doesn't take a question as a name", async () => {
    const ctx = setup({ access: "waitlist" });
    await ctx.ready;
    await ctx.nod.invites.signUpFromGroup(await ctx.userOf(ctx.s.users.jake.id));
    expect(ctx.dms(ctx.s.users.jake.id).some((t) => /what should I call you/.test(t))).toBe(false);

    const q = ctx.world.addUser({ name: "Q", platform: "iphone" });
    await ctx.nod.invites.signUpFromGroup(await ctx.store.upsertUser(q.phone));
    await ctx.dm(q.id, "what can you do?");
    expect((await ctx.store.upsertUser(q.phone)).name).toBeNull();
    expect(ctx.respond).toHaveBeenCalledTimes(1);
  });
});
