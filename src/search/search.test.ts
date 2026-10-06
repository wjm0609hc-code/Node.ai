import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import { createNod } from "../nod";
import type { SearchRequest, Searcher } from "./picks";
import { sampleSearcher } from "./samples";

const PICKS = [
  { name: "Batey", kind: "activity" as const, summary: "Mojito bar with live salsa", url: "https://batey.mx/", when: "Live music from 9pm", priceHint: "$" },
  { name: "Hartwood", kind: "restaurant" as const, summary: "Wood-fired Mexican", url: "https://www.hartwoodtulum.com/", priceHint: "$$$" },
  { name: "Full moon party", kind: "event" as const, summary: "Beach party at Papaya Playa", url: "https://papayaplaya.com/events/full-moon" },
];

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });

function fakeClaude(...responses: Array<ReturnType<typeof reply>>) {
  const requests: any[] = [];
  const create = vi.fn(async (body: any) => {
    requests.push(structuredClone(body));
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    return next;
  });
  return { client: { beta: { messages: { create } } } as unknown as AgentClient, requests };
}

const SEARCH_INPUT = { query: "fun things to do at night", location: "Tulum, Mexico", when: "Saturday, October 3, 2026, evening", party_size: 4 };

async function setup(opts: { searcher?: Searcher; responses?: Array<ReturnType<typeof reply>> } = {}) {
  const world = new ChatWorld();
  const store = new MemoryStore();
  const searcher = vi.fn(opts.searcher ?? (async (_r: SearchRequest) => ({ picks: PICKS })));
  const claude = fakeClaude(
    ...(opts.responses ?? [reply([toolUse("t1", "search_web", SEARCH_INPUT)], "tool_use"), reply([text("Here are three ideas.")])]),
  );
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4", appUrl: "https://nod.test" },
    searcher,
    makeResponder: (env) => createResponder({ ...env, client: claude.client }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const group = (await store.groupByProviderId("simulator", s.groupId))!;
  const say = async (message: string) => {
    world.say(s.users.will.id, s.groupId, message, { mentionNod: true });
    await world.settled();
  };
  const toolResult = (i = 1) => claude.requests[i].messages[2].content[0];
  return { world, store, s, group, say, searcher, claude, toolResult };
}

describe("search_web", () => {
  it("searches with only the request fields, never the chat", async () => {
    const ctx = await setup();
    await ctx.say("@Nod find us some fun things to do in Tulum on Saturday night, Mike hates clubs");
    expect(ctx.searcher).toHaveBeenCalledTimes(1);
    expect(ctx.searcher.mock.calls[0]![0]).toEqual({
      query: "fun things to do at night",
      location: "Tulum, Mexico",
      when: "Saturday, October 3, 2026, evening",
      partySize: 4,
      preferences: [],
    });
  });

  it("saves the search and its picks as options, and returns cards with a results link", async () => {
    const ctx = await setup();
    await ctx.say("@Nod find us fun things to do Saturday night");

    const result = JSON.parse(ctx.toolResult().content);
    const options = await ctx.store.listOptions(ctx.group.id);
    expect(options.map((o) => [o.kind, o.source, o.url])).toEqual([
      ["activity", "search", "https://batey.mx/"],
      ["restaurant", "search", "https://www.hartwoodtulum.com/"],
      ["event", "search", "https://papayaplaya.com/events/full-moon"],
    ]);
    expect(options[0]!.parsed).toMatchObject({ title: "Batey", summary: "Mojito bar with live salsa", when: "Live music from 9pm", priceHint: "$" });

    expect(result.picks).toEqual([
      { option_id: options[0]!.id, card: "Batey · Mojito bar with live salsa · Live music from 9pm · $ · batey.mx" },
      { option_id: options[1]!.id, card: "Hartwood · Wood-fired Mexican · $$$ · hartwoodtulum.com" },
      { option_id: options[2]!.id, card: "Full moon party · Beach party at Papaya Playa · papayaplaya.com/events/full-moon" },
    ]);
    const search = await ctx.store.getSearch(result.search_id);
    expect(search).toMatchObject({ groupId: ctx.group.id, query: "fun things to do at night", location: "Tulum, Mexico" });
    expect(result.results_page).toBe(`https://nod.test/s/${result.search_id}`);
  });

  it("lists recent picks in Claude's context for follow-ups", async () => {
    const ctx = await setup({
      responses: [
        reply([toolUse("t1", "search_web", SEARCH_INPUT)], "tool_use"),
        reply([text("Three ideas.")]),
        reply([text("Sure.")]),
      ],
    });
    await ctx.say("@Nod find us fun things to do Saturday night");
    await ctx.say("@Nod tell me more about the second one");
    const userText: string = ctx.claude.requests[2].messages[0].content;
    const [, hartwood] = await ctx.store.listOptions(ctx.group.id);
    expect(userText).toContain("<search_options>");
    expect(userText).toContain(`[option ${hartwood!.id}] Hartwood · Wood-fired Mexican · $$$ · hartwoodtulum.com`);
  });

  it("reuses an option when a pick was already shared", async () => {
    const ctx = await setup();
    await ctx.store.upsertOption({ groupId: ctx.group.id, kind: "restaurant", source: "link", url: "https://www.hartwoodtulum.com/", postedByUserId: null, providerMessageId: null });
    await ctx.say("@Nod find dinner");
    expect(await ctx.store.listOptions(ctx.group.id)).toHaveLength(3);
  });

  it("works in a private chat, without saving options", async () => {
    const ctx = await setup({
      responses: [reply([text("hi")]), reply([toolUse("t1", "search_web", SEARCH_INPUT)], "tool_use"), reply([text("Ideas.")])],
    });
    ctx.world.dm(ctx.s.users.will.id, "hey");
    await ctx.world.settled();
    ctx.world.dm(ctx.s.users.will.id, "find me something to do Saturday night");
    await ctx.world.settled();
    const result = JSON.parse(ctx.claude.requests[2].messages[2].content[0].content);
    expect(result.picks[0]).toEqual({ card: "Batey · Mojito bar with live salsa · Live music from 9pm · $ · batey.mx" });
    expect((await ctx.store.getSearch(result.search_id))?.groupId).toBeNull();
  });

  it("sends each pick in a private chat as its own picture card after a short intro", async () => {
    const ctx = await setup({
      responses: [reply([text("hi")]), reply([toolUse("t1", "search_web", SEARCH_INPUT)], "tool_use"), reply([text("Three good ones for Saturday night:")])],
    });
    ctx.world.dm(ctx.s.users.will.id, "hey");
    await ctx.world.settled();
    const before = ctx.world.dmTranscript(ctx.s.users.will.id).length;
    ctx.world.dm(ctx.s.users.will.id, "find me something to do Saturday night");
    await ctx.world.settled();
    const result = JSON.parse(ctx.claude.requests[2].messages[2].content[0].content);
    expect(result.cards).toMatch(/3 cards will follow your reply, numbered 1–3/);
    const fromNod = ctx.world.dmTranscript(ctx.s.users.will.id).slice(before).filter((l) => l.from === "nod");
    expect(fromNod[0]!.text).toBe("Three good ones for Saturday night:");
    const cards = fromNod.slice(1);
    expect(cards).toHaveLength(3);
    for (const c of cards) {
      const url = /https:\/\/nod\.test\/o\/\w+/.exec(c.text)![0];
      expect(c.text).toMatch(/^.+: https:\/\/nod\.test\/o\/\w+ \(tap to open\)$/);
      expect(c.mediaUrls).toEqual([`${url}/card.png`]);
    }
    expect(cards[0]!.text.startsWith("Batey: ")).toBe(true);
    const first = await ctx.store.getCard(/\/o\/(\w+)/.exec(cards[0]!.text)![1]!);
    expect(first).toMatchObject({ groupId: null, targetUrl: "https://batey.mx/", data: { number: 1, title: "Batey" } });
  });

  it("points cards at the reservation page with the party size and time filled in, labelled with the platform", async () => {
    const picks = [
      { ...PICKS[1]!, bookingUrl: "https://resy.com/cities/tulum/hartwood" },
      { ...PICKS[0]! },
    ];
    const input = { ...SEARCH_INPUT, date: "2026-10-03", time: "19:30", party_size: 6 };
    const ctx = await setup({
      searcher: async () => ({ picks }),
      responses: [reply([text("hi")]), reply([toolUse("t1", "search_web", input)], "tool_use"), reply([text("Two spots for Saturday:")])],
    });
    ctx.world.dm(ctx.s.users.will.id, "hey");
    await ctx.world.settled();
    const before = ctx.world.dmTranscript(ctx.s.users.will.id).length;
    ctx.world.dm(ctx.s.users.will.id, "dinner for 6 saturday 7:30");
    await ctx.world.settled();
    const cards = ctx.world.dmTranscript(ctx.s.users.will.id).slice(before).filter((l) => l.from === "nod").slice(1);
    expect(cards[0]!.text).toMatch(/^Hartwood · Book on Resy: https:\/\/nod\.test\/o\/\w+ \(tap to open\)$/);
    const card = (await ctx.store.getCard(/\/o\/(\w+)/.exec(cards[0]!.text)![1]!))!;
    expect(card.targetUrl).toBe("https://resy.com/cities/tulum/hartwood?date=2026-10-03&seats=6");
    expect(card.data).toMatchObject({ footer: "Book on Resy · 6 people" });
    // A pick with no reservation page still opens its own page.
    expect(cards[1]!.text.startsWith("Batey: ")).toBe(true);
    expect((await ctx.store.getCard(/\/o\/(\w+)/.exec(cards[1]!.text)![1]!))!.targetUrl).toBe("https://batey.mx/");
  });

  it("limits how often a chat can search", async () => {
    const ctx = await setup();
    for (let i = 0; i < 10; i++) {
      await ctx.store.createSearch({ groupId: ctx.group.id, requestedByUserId: null, query: "q", location: null, whenText: null, results: {} });
    }
    await ctx.say("@Nod find dinner");
    expect(ctx.toolResult()).toMatchObject({ is_error: true, content: "This chat has searched a lot in the last hour. Try again a bit later." });
    expect(ctx.searcher).not.toHaveBeenCalled();
  });

  it("reports a failed search briefly", async () => {
    const ctx = await setup({
      searcher: async () => {
        throw new Error("overloaded");
      },
    });
    await ctx.say("@Nod find dinner");
    expect(ctx.toolResult()).toMatchObject({ is_error: true, content: "The search didn't work this time. Tell them briefly and offer to try again." });
  });

  it("says when nothing was found", async () => {
    const ctx = await setup({ searcher: async () => ({ picks: [] }) });
    await ctx.say("@Nod find a jazz brunch");
    expect(JSON.parse(ctx.toolResult().content)).toMatchObject({ picks: [], note: "Nothing confirmed turned up. Say so, and suggest a different search." });
  });
});

describe("sample searcher (web simulator)", () => {
  it("returns labelled sample picks", async () => {
    const { picks } = await sampleSearcher({ query: "dinner", location: "Tulum" });
    expect(picks.length).toBeGreaterThanOrEqual(3);
    expect(picks.every((p) => p.name.endsWith("(sample)"))).toBe(true);
  });
});
