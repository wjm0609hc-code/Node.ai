import { beforeEach, describe, expect, it } from "vitest";
import type { InboundEvent, InboundMessage } from "../types";
import { ChatWorld, NOD_PHONE } from "./world";

function setup() {
  const world = new ChatWorld();
  const provider = world.provider();
  const received: InboundEvent[] = [];
  provider.onInbound((e) => {
    received.push(e);
  });
  return { world, provider, received };
}

function messages(events: InboundEvent[]): InboundMessage[] {
  return events.filter((e): e is InboundMessage => e.type === "message");
}

describe("existing group with history adds Nod mid-conversation", () => {
  let ctx: ReturnType<typeof setup>;
  let will: string, jake: string, sarah: string;
  let group: string;
  let history: string[];

  beforeEach(() => {
    ctx = setup();
    const { world } = ctx;
    will = world.addUser({ name: "Will", platform: "iphone" }).id;
    jake = world.addUser({ name: "Jake", platform: "iphone" }).id;
    sarah = world.addUser({ name: "Sarah", platform: "iphone" }).id;
    group = world.createGroup({ name: "Tulum", createdBy: will, members: [will, jake, sarah] });
    history = [
      world.say(will, group, "ok tulum in march, who's in"),
      world.say(jake, group, "in. https://airbnb.com/rooms/111"),
      world.say(sarah, group, "this one has a pool https://airbnb.com/rooms/222"),
    ];
    world.react(jake, history[2]!, "love");
  });

  it("delivers nothing to Nod before it joins", async () => {
    await ctx.world.settled();
    expect(ctx.received).toEqual([]);
  });

  it("emits one participant_added event naming who added Nod", async () => {
    const sarahPhone = ctx.world.user(sarah).phone;
    const result = ctx.world.addNod(group, sarah);
    await ctx.world.settled();

    expect(result).toEqual({ ok: true });
    expect(ctx.received).toHaveLength(1);
    const [event] = ctx.received;
    expect(event).toMatchObject({
      type: "participant_added",
      provider: "simulator",
      groupId: group,
      addedBy: sarahPhone,
      added: [NOD_PHONE],
      groupName: "Tulum",
      service: "imessage",
    });
    if (event?.type !== "participant_added") throw new Error("unreachable");
    expect(event.members).toHaveLength(4);
    expect(event.members).toContain(NOD_PHONE);
  });

  it("never leaks pre-join message content to Nod", async () => {
    ctx.world.addNod(group, sarah);
    ctx.world.say(will, group, "@Nod compare the two places", { mentionNod: true });
    await ctx.world.settled();

    const serialized = JSON.stringify(ctx.received);
    expect(serialized).not.toContain("airbnb.com/rooms/111");
    expect(serialized).not.toContain("who's in");
    for (const id of history) expect(serialized).not.toContain(`"messageId":"${id}"`);
  });

  it("delivers post-join messages with iMessage mentions", async () => {
    ctx.world.addNod(group, sarah);
    const id = ctx.world.say(will, group, "@Nod compare the two places", { mentionNod: true });
    await ctx.world.settled();

    const msgs = messages(ctx.received);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      messageId: id,
      groupId: group,
      from: ctx.world.user(will).phone,
      text: "@Nod compare the two places",
      service: "imessage",
      mentions: [NOD_PHONE],
    });
  });

  it("delivers a reply or tapback on a pre-join message by id only", async () => {
    ctx.world.addNod(group, sarah);
    ctx.world.say(will, group, "yes this one", { replyTo: history[2] });
    ctx.world.react(will, history[1]!, "like");
    await ctx.world.settled();

    const [, reply, reaction] = ctx.received;
    expect(reply).toMatchObject({ type: "message", replyToMessageId: history[2] });
    expect(reaction).toMatchObject({ type: "reaction", targetMessageId: history[1], reaction: "like" });
    expect(JSON.stringify(ctx.received)).not.toContain("pool");
  });

  it("shows members the full history plus a join line, and Nod only what came after", () => {
    ctx.world.addNod(group, sarah);
    ctx.world.say(will, group, "hey Nod");

    const members = ctx.world.transcript(group, will).map((l) => l.text);
    expect(members).toContain("ok tulum in march, who's in");
    expect(members).toContain("Sarah added Nod to the conversation.");

    const nod = ctx.world.transcript(group, "nod").map((l) => l.text);
    expect(nod).toEqual(["Sarah added Nod to the conversation.", "hey Nod"]);
  });

  it("doesn't quote a pre-join message in Nod's transcript when someone reacts to it", () => {
    ctx.world.addNod(group, sarah);
    ctx.world.react(will, history[2]!, "like");

    const nodView = ctx.world.transcript(group, "nod").at(-1)!;
    expect(nodView.text).not.toContain("pool");
    expect(ctx.world.transcript(group, will).at(-1)!.text).toContain("pool");
  });

  it("lets Nod reply into the group and members see it", async () => {
    ctx.world.addNod(group, sarah);
    const sent = await ctx.provider.send({ groupId: group }, { text: "Sarah added me." });

    expect(sent.service).toBe("imessage");
    const last = ctx.world.transcript(group, jake).at(-1);
    expect(last).toMatchObject({ messageId: sent.messageId, fromName: "Nod", text: "Sarah added me." });
  });

  it("does not echo Nod's own messages back to Nod", async () => {
    ctx.world.addNod(group, sarah);
    await ctx.provider.send({ groupId: group }, { text: "hi all" });
    await ctx.world.settled();
    expect(messages(ctx.received)).toEqual([]);
  });

  it("stops delivering after Nod is removed, and misses messages while out", async () => {
    ctx.world.addNod(group, sarah);
    ctx.world.removeNod(group, will);
    ctx.world.say(jake, group, "talking behind nod's back");
    await ctx.world.settled();

    expect(ctx.received.map((e) => e.type)).toEqual(["participant_added", "participant_removed"]);
    await expect(ctx.provider.send({ groupId: group }, { text: "still here?" })).rejects.toMatchObject({
      code: "not_in_group",
    });

    ctx.world.addNod(group, jake);
    await ctx.world.settled();
    expect(JSON.stringify(ctx.received)).not.toContain("behind");
  });
});

describe("Apple's rules for adding Nod", () => {
  it("rejects groups with fewer than three people", () => {
    const { world } = setup();
    const a = world.addUser({ name: "A", platform: "iphone" }).id;
    const b = world.addUser({ name: "B", platform: "iphone" }).id;
    const g = world.createGroup({ createdBy: a, members: [a, b] });
    expect(world.addNod(g, a)).toEqual({ ok: false, reason: "group_too_small" });
  });

  it("rejects adds from someone outside the group", () => {
    const { world } = setup();
    const [a, b, c, d] = ["A", "B", "C", "D"].map((n) => world.addUser({ name: n, platform: "iphone" }).id);
    const g = world.createGroup({ createdBy: a!, members: [a!, b!, c!] });
    expect(world.addNod(g, d!)).toEqual({ ok: false, reason: "not_a_member" });
  });

  it("rejects adding Nod twice", () => {
    const { world } = setup();
    const [a, b, c] = ["A", "B", "C"].map((n) => world.addUser({ name: n, platform: "iphone" }).id);
    const g = world.createGroup({ createdBy: a!, members: [a!, b!, c!] });
    world.addNod(g, a!);
    expect(world.addNod(g, b!)).toEqual({ ok: false, reason: "already_member" });
  });
});

describe("mixed iPhone/Android group", () => {
  let ctx: ReturnType<typeof setup>;
  let will: string, sarah: string, priya: string, dan: string;

  beforeEach(() => {
    ctx = setup();
    const { world } = ctx;
    will = world.addUser({ name: "Will", platform: "iphone" }).id;
    sarah = world.addUser({ name: "Sarah", platform: "iphone" }).id;
    priya = world.addUser({ name: "Priya", platform: "android" }).id;
    dan = world.addUser({ name: "Dan", platform: "android" }).id;
  });

  it("is an SMS group, and Nod cannot be added to it", async () => {
    const g = ctx.world.createGroup({ name: "Brunch", createdBy: will, members: [will, sarah, priya] });
    ctx.world.say(priya, g, "brunch sunday?");

    expect(ctx.world.groupService(g)).toBe("sms");
    expect(ctx.world.addNod(g, will)).toEqual({ ok: false, reason: "not_all_imessage" });
    await ctx.world.settled();
    expect(ctx.received).toEqual([]);
  });

  describe("created by Nod (fallback)", () => {
    let g: string;

    beforeEach(async () => {
      const phones = [will, sarah, priya, dan].map((id) => ctx.world.user(id).phone);
      const res = await ctx.provider.createGroup({
        members: phones,
        name: "Brunch",
        firstMessage: { text: "Will asked me to start this group." },
      });
      g = res.groupId;
      expect(res.service).toBe("sms");
    });

    it("sends the first message to every member, including Android", () => {
      for (const id of [will, sarah, priya, dan]) {
        expect(ctx.world.transcript(g, id).at(-1)).toMatchObject({
          fromName: "Nod",
          text: "Will asked me to start this group.",
        });
      }
    });

    it("delivers Android and iPhone messages as SMS, with no mentions or reply threading", async () => {
      ctx.world.say(priya, g, "@Nod what time works", { mentionNod: true });
      const first = ctx.world.transcript(g, will).at(-1)!.messageId;
      ctx.world.say(sarah, g, "11am", { replyTo: first, mentionNod: true });
      await ctx.world.settled();

      const msgs = messages(ctx.received);
      expect(msgs).toHaveLength(2);
      for (const m of msgs) {
        expect(m.service).toBe("sms");
        expect(m.mentions).toEqual([]);
        expect(m.replyToMessageId).toBeUndefined();
      }
      expect(msgs[0]!.from).toBe(ctx.world.user(priya).phone);
      expect(msgs[0]!.text).toBe("@Nod what time works");
    });

    it("turns tapbacks into plain text messages, not reaction events", async () => {
      const target = ctx.world.say(priya, g, "Lupa at 11?");
      ctx.world.react(will, target, "like");
      ctx.world.react(dan, target, "love");
      await ctx.world.settled();

      const types = ctx.received.map((e) => e.type);
      expect(types).not.toContain("reaction");
      const texts = messages(ctx.received).map((m) => m.text);
      expect(texts).toEqual(["Lupa at 11?", "Liked “Lupa at 11?”", "Loved “Lupa at 11?”"]);
    });

    it("drops the inline reply when Nod replies in an SMS group", async () => {
      const target = ctx.world.say(priya, g, "who's booking");
      const sent = await ctx.provider.send({ groupId: g }, { text: "I can.", replyToMessageId: target });
      const line = ctx.world.transcript(g, priya).find((l) => l.messageId === sent.messageId);
      expect(line?.replyToMessageId).toBeUndefined();
    });
  });

  it("creates an all-iPhone group over iMessage", async () => {
    const extra = ctx.world.addUser({ name: "Mike", platform: "iphone" }).id;
    const res = await ctx.provider.createGroup({
      members: [will, sarah, extra].map((id) => ctx.world.user(id).phone),
      firstMessage: { text: "hi" },
    });
    expect(res.service).toBe("imessage");
  });

  it("rejects Nod-created groups with unknown numbers or too few people", async () => {
    await expect(
      ctx.provider.createGroup({ members: [ctx.world.user(will).phone, "+19999999999"], firstMessage: { text: "hi" } }),
    ).rejects.toMatchObject({ code: "unknown_recipient" });
    await expect(
      ctx.provider.createGroup({ members: [ctx.world.user(will).phone], firstMessage: { text: "hi" } }),
    ).rejects.toMatchObject({ code: "too_few_members" });
  });
});

describe("private messages", () => {
  it("delivers a 1:1 message to Nod with groupId null and the sender's transport", async () => {
    const { world, received } = setup();
    const will = world.addUser({ name: "Will", platform: "iphone" });
    const priya = world.addUser({ name: "Priya", platform: "android" });
    world.dm(will.id, "hey");
    world.dm(priya.id, "start a group for brunch");
    await world.settled();

    expect(messages(received).map((m) => [m.groupId, m.from, m.service])).toEqual([
      [null, will.phone, "imessage"],
      [null, priya.phone, "sms"],
    ]);
  });

  it("lets Nod message a person privately, including a contact card", async () => {
    const { world, provider } = setup();
    const will = world.addUser({ name: "Will", platform: "iphone" });
    const card = { name: "Nod", phone: NOD_PHONE, photoUrl: "https://example.com/nod.png" };
    await provider.send({ phone: will.phone }, { text: "Welcome!", contactCard: card });

    expect(world.dmTranscript(will.id).at(-1)).toMatchObject({ fromName: "Nod", text: "Welcome!", contactCard: card });
  });

  it("rejects private messages to unknown numbers", async () => {
    const { provider } = setup();
    await expect(provider.send({ phone: "+19999999999" }, { text: "hi" })).rejects.toMatchObject({
      code: "unknown_recipient",
    });
  });
});

describe("handlers", () => {
  it("awaits async handlers in settled() and supports unsubscribe", async () => {
    const world = new ChatWorld();
    const seen: string[] = [];
    const off = world.provider().onInbound(async (e) => {
      await new Promise((r) => setTimeout(r, 5));
      if (e.type === "message") seen.push(e.text);
    });
    const u = world.addUser({ name: "U", platform: "iphone" });
    world.dm(u.id, "one");
    await world.settled();
    expect(seen).toEqual(["one"]);

    off();
    world.dm(u.id, "two");
    await world.settled();
    expect(seen).toEqual(["one"]);
  });

  it("surfaces handler errors from settled()", async () => {
    const world = new ChatWorld();
    world.provider().onInbound(() => {
      throw new Error("boom");
    });
    const u = world.addUser({ name: "U", platform: "iphone" });
    world.dm(u.id, "x");
    await expect(world.settled()).rejects.toThrow("boom");
  });
});
