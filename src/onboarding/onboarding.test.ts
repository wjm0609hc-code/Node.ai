import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../db/memory-store";
import type { AddressedCall } from "../inbound/pipeline";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedMixedGroup, seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld, NOD_PHONE, type TranscriptLine } from "../messaging/simulator/world";
import type {
  CreateGroupRequest,
  Destination,
  InboundEvent,
  InboundHandler,
  MessagingProvider,
  OutboundContent,
} from "../messaging/types";
import { createNod } from "../nod";

const CONFIG = { howToVideoUrl: "https://nod.test/add-nod.mp4", logoUrl: "https://nod.test/nod.png" };

function simSetup(opts: { access?: "active" | "waitlist" } = {}) {
  const world = new ChatWorld();
  const store = new MemoryStore();
  const respond = vi.fn(async (_call: AddressedCall) => {});
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: CONFIG,
    respond,
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const people = async () => registerWorldPeople(world, store, { access: opts.access ?? "active" });
  return { world, store, respond, nod, people };
}

const fromNod = (lines: TranscriptLine[]) => lines.filter((l) => l.from === "nod");

describe("when someone adds Nod to an existing group", () => {
  let ctx: ReturnType<typeof simSetup>;
  let s: ReturnType<typeof seedTulumGroup>;

  beforeEach(async () => {
    ctx = simSetup();
    s = seedTulumGroup(ctx.world);
    await ctx.people();
  });

  it("sends exactly one introduction naming who added it, with the contact card", async () => {
    ctx.world.addNod(s.groupId, s.users.sarah.id);
    await ctx.world.settled();

    const intro = fromNod(ctx.world.transcript(s.groupId, s.users.will.id));
    expect(intro).toHaveLength(1);
    const text = intro[0]!.text;
    expect(text).toMatch(/^Sarah added me\./);
    expect(text).toContain("Tag @Nod when you need me. I stay quiet otherwise.");
    expect(text).toContain("I can't see anything from before I joined, so re-send any links you're weighing and I'll compare them.");
    expect(text).toContain("@Nod forget this chat");
    expect(text).toContain("remove me like any contact");
    expect(intro[0]!.contactCard).toEqual({ name: "Nod", phone: NOD_PHONE, photoUrl: CONFIG.logoUrl });
  });

  it("records who added it", async () => {
    ctx.world.addNod(s.groupId, s.users.sarah.id);
    await ctx.world.settled();
    const group = (await ctx.store.groupByProviderId("simulator", s.groupId))!;
    const sarah = await ctx.store.upsertUser(s.users.sarah.phone);
    expect(group.addedByUserId).toBe(sarah.id);
  });

  it("then stays silent, and a repeated join event doesn't repeat the intro", async () => {
    let joinEvent: InboundEvent | undefined;
    ctx.world.provider().onInbound((e) => {
      if (e.type === "participant_added") joinEvent = e;
    });
    ctx.world.addNod(s.groupId, s.users.sarah.id);
    ctx.world.say(s.users.jake.id, s.groupId, "ok which one");
    await ctx.world.settled();
    await ctx.nod.handle(joinEvent!);

    expect(fromNod(ctx.world.transcript(s.groupId, s.users.will.id))).toHaveLength(1);
    expect(ctx.respond).not.toHaveBeenCalled();
  });

  it("introduces itself again after being removed and re-added", async () => {
    ctx.world.addNod(s.groupId, s.users.sarah.id);
    ctx.world.removeNod(s.groupId, s.users.will.id);
    ctx.world.addNod(s.groupId, s.users.mike.id);
    await ctx.world.settled();
    const intros = fromNod(ctx.world.transcript(s.groupId, s.users.will.id));
    expect(intros.map((l) => l.text.split(".")[0])).toEqual(["Sarah added me", "Mike added me"]);
  });

  it("tells someone without access, privately, how to get it", async () => {
    const sarah = await ctx.store.upsertUser(s.users.sarah.phone);
    await ctx.store.setUserAccess(sarah.id, "waitlist");
    ctx.world.addNod(s.groupId, s.users.sarah.id);
    await ctx.world.settled();

    expect(fromNod(ctx.world.transcript(s.groupId, s.users.will.id))).toHaveLength(1);
    const dm = fromNod(ctx.world.dmTranscript(s.users.sarah.id));
    expect(dm).toHaveLength(1);
    expect(dm[0]!.text).toContain("invite");
    expect(dm[0]!.text).toContain("Tulum");
  });

  it("uses a neutral opener when it doesn't know the adder's name", async () => {
    const fresh = simSetup();
    const t = seedTulumGroup(fresh.world); // no names registered
    fresh.world.addNod(t.groupId, t.users.sarah.id);
    await fresh.world.settled();
    expect(fromNod(fresh.world.transcript(t.groupId, t.users.will.id))[0]!.text).toMatch(/^Hi, I'm Nod\./);
  });

  it("resends its card when asked in the group, without reaching the orchestrator", async () => {
    ctx.world.addNod(s.groupId, s.users.sarah.id);
    ctx.world.say(s.users.jake.id, s.groupId, "@Nod your card?", { mentionNod: true });
    ctx.world.say(s.users.jake.id, s.groupId, "save contact"); // not addressed: ignored
    await ctx.world.settled();

    const nodLines = fromNod(ctx.world.transcript(s.groupId, s.users.jake.id));
    expect(nodLines).toHaveLength(2);
    expect(nodLines[1]).toMatchObject({ text: "Here's my card. Save it and I'll show up as Nod." });
    expect(nodLines[1]!.contactCard?.name).toBe("Nod");
    expect(ctx.respond).not.toHaveBeenCalled();
  });

  it("passes other calls on to the orchestrator", async () => {
    ctx.world.addNod(s.groupId, s.users.sarah.id);
    ctx.world.say(s.users.will.id, s.groupId, "@Nod compare the two", { mentionNod: true });
    await ctx.world.settled();
    expect(ctx.respond).toHaveBeenCalledTimes(1);
  });
});

describe("personal setup on first private contact", () => {
  it("sends the welcome with card, the how-to video, and a privacy note, once", async () => {
    const ctx = simSetup();
    const will = ctx.world.addUser({ name: "Will", platform: "iphone" });
    await ctx.people();
    ctx.world.dm(will.id, "hi");
    await ctx.world.settled();
    ctx.world.dm(will.id, "what can you do?");
    await ctx.world.settled();

    const setup = fromNod(ctx.world.dmTranscript(will.id));
    expect(setup).toHaveLength(3);
    expect(setup[0]!.text).toMatch(/^Hi, I'm Nod/);
    expect(setup[0]!.contactCard?.name).toBe("Nod");
    expect(setup[1]!.text).toContain("tap the group name, tap Add Contact, then type Nod");
    expect(setup[1]!.mediaUrls).toEqual([CONFIG.howToVideoUrl]);
    expect(setup[2]!.text).toMatch(/^On privacy:/);
    // the first message itself still goes on to the orchestrator after setup
    expect(ctx.respond).toHaveBeenCalledTimes(2);
  });

  it("skips setup for people without access", async () => {
    const ctx = simSetup({ access: "waitlist" });
    const will = ctx.world.addUser({ name: "Will", platform: "iphone" });
    await ctx.people();
    ctx.world.dm(will.id, "hi");
    await ctx.world.settled();
    // no welcome, card or video: just the waitlist reply (src/invites)
    const lines = fromNod(ctx.world.dmTranscript(will.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toMatch(/invite-only for now, so you're on the waitlist/);
    expect(lines[0]!.contactCard).toBeUndefined();
  });

  it("doesn't send the card twice when the first message asks for it", async () => {
    const ctx = simSetup();
    const will = ctx.world.addUser({ name: "Will", platform: "iphone" });
    await ctx.people();
    ctx.world.dm(will.id, "add me");
    await ctx.world.settled();
    const cards = fromNod(ctx.world.dmTranscript(will.id)).filter((l) => l.contactCard);
    expect(cards).toHaveLength(1);

    ctx.world.dm(will.id, "save contact");
    await ctx.world.settled();
    expect(fromNod(ctx.world.dmTranscript(will.id)).at(-1)).toMatchObject({ text: "Here's my card. Save it and I'll show up as Nod." });
  });
});

describe("start a group (fallback)", () => {
  let ctx: ReturnType<typeof simSetup>;
  let s: ReturnType<typeof seedMixedGroup>;

  beforeEach(async () => {
    ctx = simSetup();
    s = seedMixedGroup(ctx.world); // Will, Sarah (iPhone), Priya, Dan (Android)
    await ctx.people();
    ctx.world.dm(s.users.will.id, "hi"); // get personal setup out of the way
    await ctx.world.settled();
  });

  const lastDm = (id: string) => fromNod(ctx.world.dmTranscript(id)).at(-1)!;
  const nodGroups = () => ctx.world.allGroups().filter((g) => g.hasNod);

  it("creates a mixed iPhone/Android group from shared contact cards and introduces itself", async () => {
    const cards = [s.users.sarah, s.users.priya, s.users.dan].map((u) => ({ name: u.name, phone: u.phone }));
    ctx.world.dm(s.users.will.id, "Start a group for Brunch with Sarah, Priya, and Dan", { contactCards: cards });
    await ctx.world.settled();

    const [g] = nodGroups();
    expect(g).toBeTruthy();
    expect(g!.name).toBe("Brunch");
    expect(g!.service).toBe("sms");
    expect(g!.members.sort()).toEqual(["nod", s.users.will.id, s.users.sarah.id, s.users.priya.id, s.users.dan.id].sort());
    for (const u of Object.values(s.users)) {
      const intro = fromNod(ctx.world.transcript(g!.id, u.id));
      expect(intro).toHaveLength(1);
      expect(intro[0]!.text).toMatch(/^Will asked me to start this group\./);
      expect(intro[0]!.contactCard?.name).toBe("Nod");
    }
    const stored = (await ctx.store.groupByProviderId("simulator", g!.id))!;
    const will = await ctx.store.upsertUser(s.users.will.phone);
    expect(stored).toMatchObject({ createdByNod: true, addedByUserId: will.id });
    expect(ctx.respond).toHaveBeenCalledTimes(1); // only the "hi"
  });

  it("finds people by name through chats they share with the requester", async () => {
    const t = ctx.world.createGroup({ name: "Work", createdBy: s.users.will.id, members: [s.users.will.id, s.users.sarah.id, ctx.world.addUser({ name: "Kai", platform: "iphone" }).id] });
    await ctx.people();
    ctx.world.addNod(t, s.users.will.id);
    await ctx.world.settled();

    ctx.world.dm(s.users.will.id, "start a group with Kai and Sarah");
    await ctx.world.settled();
    expect(nodGroups().filter((g) => g.id !== t)).toHaveLength(1);
  });

  it("accepts phone numbers", async () => {
    ctx.world.dm(s.users.will.id, `start a group with ${s.users.priya.phone} and ${s.users.dan.phone.slice(2)}`);
    await ctx.world.settled();
    expect(nodGroups()).toHaveLength(1);
  });

  it("asks for numbers it doesn't have", async () => {
    ctx.world.dm(s.users.will.id, "start a group for Tulum with Jake and Mike");
    await ctx.world.settled();
    expect(nodGroups()).toEqual([]);
    expect(lastDm(s.users.will.id).text).toBe(
      "I don't have a number for Jake or Mike. Share their contact cards or send their numbers, then ask again.",
    );
  });

  it("asks which person when a name matches more than one", async () => {
    const will = await ctx.store.upsertUser(s.users.will.phone);
    await ctx.store.saveContacts(will.id, [
      { name: "Sam Lee", phone: s.users.priya.phone },
      { name: "Sam Ortiz", phone: s.users.dan.phone },
    ]);
    ctx.world.dm(s.users.will.id, "start a group with Sam and Sarah");
    await ctx.world.settled();
    expect(nodGroups()).toEqual([]);
    expect(lastDm(s.users.will.id).text).toBe("You know more than one Sam. Which one? Send their full name or number.");
  });

  it("asks who should be in it when nobody is named", async () => {
    ctx.world.dm(s.users.will.id, "start a group");
    await ctx.world.settled();
    expect(lastDm(s.users.will.id).text).toBe("Who should be in it? Try: start a group for Tulum with Jake, Sarah, and Mike.");
  });

  it("requires access", async () => {
    const will = await ctx.store.upsertUser(s.users.will.phone);
    await ctx.store.setUserAccess(will.id, "waitlist");
    ctx.world.dm(s.users.will.id, `start a group with ${s.users.priya.phone}`);
    await ctx.world.settled();
    expect(nodGroups()).toEqual([]);
    expect(lastDm(s.users.will.id).text).toContain("invite");
  });

  it("is only handled privately; in a group it goes to the orchestrator", async () => {
    const t = ctx.world.createGroup({ name: "Work", createdBy: s.users.will.id, members: [s.users.will.id, s.users.sarah.id, ctx.world.addUser({ name: "Kai", platform: "iphone" }).id] });
    ctx.world.addNod(t, s.users.will.id);
    ctx.world.say(s.users.will.id, t, "@Nod start a group with Priya", { mentionNod: true });
    await ctx.world.settled();
    expect(nodGroups()).toHaveLength(1);
    expect(ctx.respond).toHaveBeenCalledTimes(2);
  });
});

// A provider that accepts anything, for events the simulator can't produce
// (Apple blocks adding Nod to SMS groups; first contact via message without a join event).
class FakeProvider implements MessagingProvider {
  readonly name = "fake";
  readonly selfPhone = NOD_PHONE;
  sent: Array<{ to: Destination; content: OutboundContent }> = [];
  created: CreateGroupRequest[] = [];
  private n = 0;
  onInbound(_h: InboundHandler) {
    return () => {};
  }
  async send(to: Destination, content: OutboundContent) {
    this.sent.push({ to, content });
    return { messageId: `f${++this.n}`, service: "imessage" as const };
  }
  async createGroup(req: CreateGroupRequest) {
    this.created.push(req);
    return { groupId: `fg${++this.n}`, service: "imessage" as const };
  }
}

describe("events the simulator can't produce", () => {
  function fakeSetup() {
    const store = new MemoryStore();
    const provider = new FakeProvider();
    const respond = vi.fn(async (_call: AddressedCall) => {});
    const nod = createNod({ store, provider, classify: async () => false, logger: silentLogger, config: CONFIG, respond });
    return { store, provider, nod, respond };
  }
  const WILL = "+15550200001";
  const msg = (over: Record<string, unknown>) =>
    ({
      type: "message",
      provider: "fake",
      messageId: `in-${Math.random()}`,
      groupId: "grp-9",
      from: WILL,
      text: "hi all",
      mediaUrls: [],
      service: "imessage",
      mentions: [],
      sentAt: new Date(),
      ...over,
    }) as InboundEvent;

  it("introduces itself on the first message from an unknown group, before answering a call in it", async () => {
    const ctx = fakeSetup();
    await ctx.nod.handle(msg({ text: "@Nod hi" }));
    expect(ctx.provider.sent).toHaveLength(1);
    expect(ctx.provider.sent[0]!.to).toEqual({ groupId: "grp-9" });
    expect(ctx.provider.sent[0]!.content.text).toMatch(/^Hi, I'm Nod\./);
    expect(ctx.respond).toHaveBeenCalledTimes(1);

    await ctx.nod.handle(msg({ text: "another" }));
    expect(ctx.provider.sent).toHaveLength(1);
  });

  it("offers the fallback privately when added to a group it can't work in", async () => {
    const ctx = fakeSetup();
    const will = await ctx.store.upsertUser(WILL);
    await ctx.store.setUserAccess(will.id, "active");
    await ctx.store.claimSetup(will.id);
    await ctx.nod.handle({
      type: "participant_added",
      provider: "fake",
      groupId: "sms-1",
      addedBy: WILL,
      added: [NOD_PHONE],
      members: [WILL, "+15550200002", "+15550200003", NOD_PHONE],
      groupName: "Brunch",
      service: "sms",
      sentAt: new Date(),
    });
    expect(ctx.provider.sent).toHaveLength(1);
    expect(ctx.provider.sent[0]!.to).toEqual({ phone: WILL });
    expect(ctx.provider.sent[0]!.content.text).toBe(
      'I can\'t join Brunch because not everyone there is on iMessage. Want me to start a fresh group with the same people? Just reply "start a group".',
    );

    await ctx.nod.handle(msg({ groupId: null, text: "start a group" }));
    expect(ctx.provider.created).toHaveLength(1);
    expect(ctx.provider.created[0]!.name).toBe("Brunch");
    expect(ctx.provider.created[0]!.members.sort()).toEqual([WILL, "+15550200002", "+15550200003"].sort());
    expect(ctx.provider.created[0]!.firstMessage.text).toMatch(/^Will asked me|^You asked me|asked me to start this group/);
  });
});
