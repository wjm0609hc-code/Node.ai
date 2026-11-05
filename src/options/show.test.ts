import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import type { Destination, OutboundContent } from "../messaging/types";
import { createNod } from "../nod";

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });
type Scripted = ReturnType<typeof reply> | ((body: any) => ReturnType<typeof reply>);
const CARD = /^.+: nod\.test\/o\/([A-Za-z0-9]{12})$/;

async function setup(responses: Scripted[]) {
  const world = new ChatWorld();
  const store = new MemoryStore();
  const create = vi.fn(async (body: any) => {
    const next = responses.shift();
    if (!next) return reply([text("ok")]);
    return typeof next === "function" ? next(body) : next;
  });
  const listing = (title: string, photo: string) =>
    `<html><head><meta property="og:title" content="${title}"><meta property="og:image" content="${photo}"></head></html>`;
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4", appUrl: "https://nod.test" },
    fetchListing: async (url) => (url.includes("111") ? listing("Casa Azul", "https://img.test/a.jpg") : listing("Jungle Loft", "https://img.test/b.jpg")),
    makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const group = (await store.groupByProviderId("simulator", s.groupId))!;
  const say = async (message: string) => {
    world.say(s.users.will.id, s.groupId, message, { mentionNod: message.includes("@Nod") });
    await world.settled();
  };
  const nodLines = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1).map((l) => l.text);
  const cardOf = async (line: string) => (await store.getCard(CARD.exec(line)![1]!))!;
  /** The cards behind a combined message's numbered lines, in order. */
  const sheetCards = async (text: string) =>
    Promise.all([...text.matchAll(/^\d+ .+ · nod\.test\/o\/([A-Za-z0-9]{12})$/gm)].map(async (m) => (await store.getCard(m[1]!))!));
  const nodMedia = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1).map((l) => l.mediaUrls);
  return { world, store, nod, s, group, say, nodLines, cardOf, sheetCards, nodMedia, create };
}

const optionIds = (body: any): string[] => [...String(body.messages[0].content).matchAll(/\[option ([^\]]+)\]/g)].map((m) => m[1]!);

describe("cards in replies", () => {
  it("sends several options as one message: the reply, a numbered link per option, and one picture of them all", async () => {
    const ctx = await setup([
      (b) => reply([toolUse("t", "show_options", { option_ids: optionIds(b).reverse() })], "tool_use"),
      reply([text("Two good ones:")]),
    ]);
    await ctx.say("here https://www.airbnb.com/rooms/111 and https://www.airbnb.com/rooms/222");
    await ctx.say("@Nod show us the options");
    const lines = ctx.nodLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Two good ones:\n1 Jungle Loft · nod\.test\/o\/\w{12}\n2 Casa Azul · nod\.test\/o\/\w{12}$/);
    const [first, second] = await ctx.sheetCards(lines[0]!);
    expect([first!.data.number, first!.targetUrl]).toEqual([1, "https://www.airbnb.com/rooms/222"]);
    expect([second!.data.number, second!.targetUrl]).toEqual([2, "https://www.airbnb.com/rooms/111"]);
    expect(ctx.nodMedia()[0]).toEqual([`https://nod.test/o/s/${first!.id}-${second!.id}/sheet.png`]);
  });

  it("replaces a listing's card with its numbered one when the same reply compares several", async () => {
    const ctx = await setup([
      reply([toolUse("a", "parse_listing", { url: "https://www.airbnb.com/rooms/111" }), toolUse("b", "parse_listing", { url: "https://www.airbnb.com/rooms/222" })], "tool_use"),
      (b) => {
        const ids = b.messages.at(-1).content.map((r: any) => JSON.parse(r.content).option_id);
        return reply([toolUse("c", "show_options", { option_ids: ids })], "tool_use");
      },
      reply([text("Here they are side by side.")]),
    ]);
    await ctx.say("@Nod compare https://www.airbnb.com/rooms/111 and https://www.airbnb.com/rooms/222");
    const lines = ctx.nodLines();
    expect(lines).toHaveLength(1); // one message, with two numbered links, not four
    const cards = await ctx.sheetCards(lines[0]!);
    expect(cards.map((c) => [c.data.number, c.data.title, c.photoUrl])).toEqual([
      [1, "Casa Azul", "https://img.test/a.jpg"],
      [2, "Jungle Loft", "https://img.test/b.jpg"],
    ]);
  });

  it("sends the cards even when Claude adds no text", async () => {
    const ctx = await setup([(b) => reply([toolUse("t", "show_options", { option_ids: optionIds(b).slice(0, 1) })], "tool_use"), reply([])]);
    await ctx.say("https://www.airbnb.com/rooms/111");
    await ctx.say("@Nod show it");
    expect(ctx.nodLines()).toEqual([expect.stringMatching(CARD)]);
  });

  it("refuses options from another chat, and works only in groups", async () => {
    const ctx = await setup([reply([toolUse("t", "show_options", { option_ids: ["nope"] })], "tool_use"), reply([text("Hmm.")])]);
    await ctx.say("@Nod show it");
    expect(ctx.create.mock.calls[1]![0].messages.at(-1).content[0]).toMatchObject({ is_error: true, content: "No option nope in this chat." });
  });

  it("after a failed send, a retry sends the combined message once", async () => {
    const ctx = await setup([
      (b) => reply([toolUse("t", "show_options", { option_ids: optionIds(b) })], "tool_use"),
      reply([text("Here you go.")]),
    ]);
    await ctx.say("https://www.airbnb.com/rooms/111 https://www.airbnb.com/rooms/222");
    const provider = ctx.nod.provider;
    const realSend = provider.send.bind(provider);
    let fails = 1;
    provider.send = async (to: Destination, content: OutboundContent) => {
      if (content.mediaUrls?.[0]?.endsWith("/sheet.png") && fails-- > 0) throw new Error("sendblue timeout");
      return realSend(to, content);
    };
    const messageId = ctx.world.say(ctx.s.users.will.id, ctx.s.groupId, "@Nod options?", { mentionNod: true });
    await ctx.world.settled();
    expect(ctx.nodLines()).toEqual([]);
    await ctx.nod.handleAddressed(
      {
        event: { type: "message", provider: "simulator", messageId, groupId: ctx.s.groupId, from: ctx.s.users.will.phone, text: "@Nod options?", mediaUrls: [], service: "imessage", mentions: [], sentAt: new Date() },
        decision: { addressed: true, tier: "certain", reason: "mention" },
        groupId: ctx.group.id,
        senderUserId: (await ctx.store.upsertUser(ctx.s.users.will.phone)).id,
        firstSeenGroup: false,
      },
      { final: true },
    );
    await ctx.world.settled();
    provider.send = realSend;
    const lines = ctx.nodLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Here you go\.\n1 .+\n2 .+$/);
  });
});
