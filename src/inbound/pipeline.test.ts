import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb, type TestDb } from "../db/testing";
import { DrizzleStore } from "../db/store";
import { ChatWorld, NOD_PHONE } from "../messaging/simulator/world";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import type { InboundEvent, InboundMessage } from "../messaging/types";
import { RecordingProvider } from "./recording-provider";
import { createInboundPipeline, type AddressedCall, type InboundResult, type Logger } from "./pipeline";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});

function logger() {
  const lines: Array<{ level: string; msg: string; fields: unknown }> = [];
  const make = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const log: Logger = { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
  return { log, lines };
}

async function setup(opts: { classify?: (i: { text: string; recent: unknown[] }) => Promise<boolean> } = {}) {
  await resetTestDb(db);
  const store = new DrizzleStore(db);
  const world = new ChatWorld();
  const classify = vi.fn(opts.classify ?? (async () => false));
  const calls: AddressedCall[] = [];
  const { log, lines } = logger();
  const pipeline = createInboundPipeline({
    store,
    selfPhone: NOD_PHONE,
    classify,
    logger: log,
    onAddressed: async (call) => {
      calls.push(call);
    },
  });
  const results: InboundResult[] = [];
  world.provider().onInbound(async (e) => {
    results.push(await pipeline.handle(e));
  });
  const nod = new RecordingProvider(world.provider(), store);
  const s = seedTulumGroup(world);
  return { store, world, classify, calls, lines, pipeline, results, nod, s };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function joined(ctx: Ctx) {
  ctx.world.addNod(ctx.s.groupId, ctx.s.users.sarah.id);
  await ctx.world.settled();
}

async function say(ctx: Ctx, who: keyof Ctx["s"]["users"], text: string, opts: Parameters<ChatWorld["say"]>[3] = {}) {
  const id = ctx.world.say(ctx.s.users[who].id, ctx.s.groupId, text, opts);
  await ctx.world.settled();
  return { id, result: ctx.results.at(-1)! };
}

describe("inbound pipeline with a group that adds Nod mid-conversation", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("records the group, its members and who added Nod, but no history", async () => {
    await joined(ctx);
    expect(ctx.results).toHaveLength(1);
    expect(ctx.results[0]).toMatchObject({
      status: "membership",
      firstSeenGroup: true,
      nodAdded: true,
      addedByPhone: ctx.s.users.sarah.phone,
    });
    const group = await ctx.store.groupByProviderId("simulator", ctx.s.groupId);
    expect(group?.joinedAt).toBeInstanceOf(Date);
    expect(group?.name).toBe("Tulum 🌴");
    expect(await ctx.store.memberPhones(group!.id)).toHaveLength(4);
    expect(await ctx.store.recentMessages({ groupId: group!.id }, 100)).toEqual([]);
  });

  it("hands an @Nod message to the orchestrator and stores it", async () => {
    await joined(ctx);
    const { result } = await say(ctx, "will", "@Nod compare the two places", { mentionNod: true });

    expect(result).toMatchObject({ status: "stored", addressed: true, reason: "mention" });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]!.event.text).toBe("@Nod compare the two places");
    expect(ctx.calls[0]!.decision.reason).toBe("mention");
    expect(ctx.calls[0]!.senderUserId).toBeTruthy();
  });

  it("asks the classifier about an ambiguous 'nod', with recent post-join context", async () => {
    await joined(ctx);
    await say(ctx, "will", "which one has the pool");
    const { result } = await say(ctx, "jake", "I'd give it the nod");

    expect(result).toMatchObject({ status: "stored", addressed: false, reason: "classifier_no" });
    expect(ctx.classify).toHaveBeenCalledWith({
      text: "I'd give it the nod",
      recent: [{ from: "A member", text: "which one has the pool" }],
    });
    expect(ctx.calls).toEqual([]);
  });

  it("stays silent on ordinary chat without calling the classifier", async () => {
    await joined(ctx);
    const { result } = await say(ctx, "mike", "I'm nodding off, talk tomorrow");
    expect(result).toMatchObject({ status: "stored", addressed: false, reason: "no_name" });
    expect(ctx.classify).not.toHaveBeenCalled();
  });

  it("treats an inline reply to Nod's own message as a call", async () => {
    await joined(ctx);
    const sent = await ctx.nod.send({ groupId: ctx.s.groupId }, { text: "Sarah added me. Tag @Nod when you need me." });
    const { result } = await say(ctx, "will", "cool, compare the two then", { replyTo: sent.messageId });
    expect(result).toMatchObject({ addressed: true, reason: "reply_to_nod" });
  });

  it("stores tapbacks on messages Nod saw and ignores ones on history", async () => {
    await joined(ctx);
    const { id } = await say(ctx, "sarah", "vote: pool house?");
    ctx.world.react(ctx.s.users.will.id, id, "like");
    ctx.world.react(ctx.s.users.will.id, ctx.s.historyMessageIds[2]!, "love");
    await ctx.world.settled();

    expect(ctx.results.at(-2)).toMatchObject({ status: "reaction", stored: true });
    expect(ctx.results.at(-1)).toMatchObject({ status: "reaction", stored: false });
    const will = await ctx.store.upsertUser(ctx.s.users.will.phone);
    expect(await ctx.store.reactionsFor("simulator", id)).toEqual({ [will.id]: "like" });
    expect(ctx.calls).toEqual([]);
  });

  it("ignores a repeated delivery of the same message", async () => {
    await joined(ctx);
    let captured: InboundEvent | undefined;
    const off = ctx.world.provider().onInbound((e) => {
      captured = e;
    });
    await say(ctx, "will", "@Nod hi", { mentionNod: true });
    off();

    expect(await ctx.pipeline.handle(captured!)).toMatchObject({ status: "duplicate" });
    expect(ctx.calls).toHaveLength(1);
  });

  it("does not store an opted-out member's messages unless they call Nod", async () => {
    await joined(ctx);
    const group = (await ctx.store.groupByProviderId("simulator", ctx.s.groupId))!;
    const mike = await ctx.store.upsertUser(ctx.s.users.mike.phone);
    await ctx.store.setOptedOut(group.id, mike.id, true);

    await say(ctx, "mike", "my private opinion");
    await say(ctx, "mike", "@Nod what's the tab", { mentionNod: true });

    const texts = (await ctx.store.recentMessages({ groupId: group.id }, 100)).map((m) => m.text);
    expect(texts).not.toContain("my private opinion");
    expect(texts).toContain("@Nod what's the tab");
    expect(ctx.calls).toHaveLength(1);
  });

  it("never logs message text at info level", async () => {
    await joined(ctx);
    await say(ctx, "will", "@Nod secret plans", { mentionNod: true });
    await say(ctx, "jake", "gave it the nod quietly");
    const info = ctx.lines.filter((l) => l.level !== "debug");
    expect(info.length).toBeGreaterThan(0);
    const dump = JSON.stringify(info);
    expect(dump).not.toContain("secret plans");
    expect(dump).not.toContain("quietly");
  });
});

describe("inbound pipeline: other cases", () => {
  it("answers every private message", async () => {
    const ctx = await setup();
    ctx.world.dm(ctx.s.users.will.id, "start a group for Tulum");
    await ctx.world.settled();
    expect(ctx.results.at(-1)).toMatchObject({ status: "stored", addressed: true, reason: "private" });
    expect(ctx.calls[0]!.groupId).toBeNull();
  });

  it("flags a group seen for the first time through a message (no join event)", async () => {
    const ctx = await setup();
    const event: InboundMessage = {
      type: "message",
      provider: "sendblue",
      messageId: "sb-1",
      groupId: "sb-group-9",
      from: "+15550209999",
      text: "hi everyone",
      mediaUrls: [],
      service: "imessage",
      mentions: [],
      sentAt: new Date(),
    };
    expect(await ctx.pipeline.handle(event)).toMatchObject({ status: "stored", firstSeenGroup: true });
    expect(await ctx.pipeline.handle({ ...event, messageId: "sb-2" })).toMatchObject({ firstSeenGroup: false });
  });

  it("ignores Nod's own messages echoed back by the provider", async () => {
    const ctx = await setup();
    const event: InboundMessage = {
      type: "message",
      provider: "sendblue",
      messageId: "sb-echo",
      groupId: null,
      from: NOD_PHONE,
      text: "Welcome!",
      mediaUrls: [],
      service: "imessage",
      mentions: [],
      sentAt: new Date(),
    };
    expect(await ctx.pipeline.handle(event)).toEqual({ status: "ignored", why: "from_nod" });
  });

  it("stays silent and keeps the message when the classifier fails", async () => {
    const ctx = await setup({
      classify: async () => {
        throw new Error("timeout");
      },
    });
    await joined(ctx);
    const { result } = await say(ctx, "jake", "gave it the nod");
    expect(result).toMatchObject({ status: "stored", addressed: false, reason: "classifier_error" });
  });

  it("can run the call handling after the webhook has answered", async () => {
    await resetTestDb(db);
    const store = new DrizzleStore(db);
    const handled: string[] = [];
    const pipeline = createInboundPipeline({
      store,
      selfPhone: NOD_PHONE,
      classify: async () => false,
      logger: logger().log,
      onAddressed: async (c) => {
        handled.push(c.event.messageId);
      },
    });
    const deferred: Array<() => Promise<void>> = [];
    const result = await pipeline.handle(
      {
        type: "message",
        provider: "sendblue",
        messageId: "d1",
        groupId: null,
        from: "+15550201111",
        text: "hi",
        mediaUrls: [],
        service: "imessage",
        mentions: [],
        sentAt: new Date(),
      },
      { defer: (task) => deferred.push(task) },
    );
    expect(result).toMatchObject({ status: "stored", addressed: true, deferred: true });
    expect(handled).toEqual([]);
    await deferred[0]!();
    expect(handled).toEqual(["d1"]);
  });

  it("reports an orchestrator failure without throwing", async () => {
    await resetTestDb(db);
    const store = new DrizzleStore(db);
    const { log, lines } = logger();
    const pipeline = createInboundPipeline({
      store,
      selfPhone: NOD_PHONE,
      classify: async () => false,
      logger: log,
      onAddressed: async () => {
        throw new Error("claude down");
      },
    });
    const result = await pipeline.handle({
      type: "message",
      provider: "sendblue",
      messageId: "x1",
      groupId: null,
      from: "+15550201111",
      text: "hi",
      mediaUrls: [],
      service: "imessage",
      mentions: [],
      sentAt: new Date(),
    });
    expect(result).toMatchObject({ status: "stored", addressed: true, handlerError: true });
    expect(lines.some((l) => l.level === "error")).toBe(true);
  });
});

describe("inbound pipeline: provider participant lists", () => {
  it("adds every listed participant as a member and keeps the group's name", async () => {
    const ctx = await setup();
    const event: InboundMessage = {
      type: "message", provider: "sendblue", messageId: "mh-1", groupId: "sb-grp-1", from: "+15550300001", text: "hi all",
      mediaUrls: [], service: "imessage", mentions: [], sentAt: new Date(),
      participants: ["+15550300002", "+15550300003", NOD_PHONE], groupName: "Lake weekend",
    };
    await ctx.pipeline.handle(event);
    const group = (await ctx.store.groupByProviderId("sendblue", "sb-grp-1"))!;
    expect(group.name).toBe("Lake weekend");
    expect((await ctx.store.memberPhones(group.id)).sort()).toEqual(["+15550300001", "+15550300002", "+15550300003"]);
    await ctx.pipeline.handle({ ...event, messageId: "mh-2", participants: ["+15550300002", "+15550300003", "+15550300004"] });
    expect(await ctx.store.memberPhones(group.id)).toHaveLength(4);
  });
});
