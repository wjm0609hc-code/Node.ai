import { beforeEach, describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import { createNod } from "../nod";
import { SAMPLE_LISTINGS, sampleListingFetcher } from "./samples";

const CASA = `<meta property="og:title" content="Casa Azul · Condo in Tulum · ★4.92 · 2 bedrooms · 3 beds · 2 baths">
<meta property="og:image" content="https://img.test/casa.jpg">
<meta property="og:description" content="Sleeps 6 guests. Free cancellation before Mar 1.">`;
const LOFT = `<meta property="og:title" content="Jungle Loft · Loft in Tulum · 1 bedroom"><meta property="og:image" content="https://img.test/loft.jpg">`;

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });

type Scripted = ReturnType<typeof reply> | ((body: any) => ReturnType<typeof reply>);

/** Fake Claude. A response can be a function of the request, e.g. to read an option id from the context. */
function fakeClaude(...responses: Scripted[]) {
  const requests: any[] = [];
  const create = vi.fn(async (body: any) => {
    requests.push(structuredClone(body));
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    return typeof next === "function" ? next(body) : next;
  });
  return { client: { beta: { messages: { create } } } as unknown as AgentClient, requests };
}

async function setup(claude = fakeClaude()) {
  const world = new ChatWorld();
  const store = new MemoryStore();
  const pages: Record<string, string> = {
    "https://www.airbnb.com/rooms/111": CASA,
    "https://www.airbnb.com/rooms/222": LOFT,
  };
  const fetchListing = vi.fn(async (url: string) => {
    if (!(url in pages)) throw new Error("403");
    return pages[url]!;
  });
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4", appUrl: "https://nod.test" },
    fetchListing,
    makeResponder: (env) => createResponder({ ...env, client: claude.client }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const group = (await store.groupByProviderId("simulator", s.groupId))!;
  const say = async (who: keyof typeof s.users, message: string) => {
    world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod") });
    await world.settled();
  };
  const nodLines = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1);
  return { world, store, s, group, say, nodLines, fetchListing, claude };
}

describe("capturing rental links", () => {
  it("saves rental links quietly, once, with who posted them", async () => {
    const ctx = await setup();
    await ctx.say("jake", "this one https://www.airbnb.com/rooms/111?source_impression_id=abc has a pool");
    await ctx.say("mike", "or https://airbnb.com/rooms/111 and https://youtube.com/watch?v=1");

    expect(ctx.nodLines()).toEqual([]);
    const options = await ctx.store.listOptions(ctx.group.id);
    expect(options.map((o) => o.url)).toEqual(["https://www.airbnb.com/rooms/111"]);
    const jake = await ctx.store.upsertUser(ctx.s.users.jake.phone);
    expect(options[0]).toMatchObject({ kind: "rental", source: "link", postedByUserId: jake.id });
    expect(ctx.fetchListing).not.toHaveBeenCalled(); // nothing is fetched until someone asks
  });

  it("never sees links from before Nod joined", async () => {
    const ctx = await setup(); // the seeded history mentions rooms/111 and rooms/222
    expect(await ctx.store.listOptions(ctx.group.id)).toEqual([]);
  });

  it("skips links from members who opted out", async () => {
    const ctx = await setup();
    const mike = await ctx.store.upsertUser(ctx.s.users.mike.phone);
    await ctx.store.setOptedOut(ctx.group.id, mike.id, true);
    await ctx.say("mike", "https://www.airbnb.com/rooms/222");
    expect(await ctx.store.listOptions(ctx.group.id)).toEqual([]);
  });
});

describe("rental tools and context", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  it("lists the rentals shared so far in Claude's context", async () => {
    const claude = fakeClaude(reply([text("ok")]));
    ctx = await setup(claude);
    await ctx.say("jake", "https://www.airbnb.com/rooms/111");
    await ctx.say("will", "@Nod compare these https://www.airbnb.com/rooms/222");

    const userText: string = claude.requests[0].messages[0].content;
    const section = userText.slice(userText.indexOf("<rental_options>"), userText.indexOf("</rental_options>"));
    const [a, b] = await ctx.store.listOptions(ctx.group.id);
    expect(section).toContain(`[option ${a!.id}] https://www.airbnb.com/rooms/111 (posted by Jake, not checked yet)`);
    expect(section).toContain(`[option ${b!.id}] https://www.airbnb.com/rooms/222 (posted by Will, not checked yet)`);
    expect(claude.requests[0].tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["parse_listing", "update_option"]));
  });

  describe("parse_listing", () => {
    beforeEach(async () => {
      const claude = fakeClaude(
        reply([toolUse("t1", "parse_listing", { url: "https://www.airbnb.com/rooms/111?utm_source=x" })], "tool_use"),
        reply([text("Casa Azul, Tulum · sleeps 6 · 2 BR · ★4.92. Jake, what's the nightly price? Reply to this message.")]),
      );
      ctx = await setup(claude);
      await ctx.say("jake", "@Nod what about https://www.airbnb.com/rooms/111");
    });

    it("reads the page and returns a card, missing fields and the poster", async () => {
      expect(ctx.fetchListing).toHaveBeenCalledWith("https://www.airbnb.com/rooms/111");
      const result = JSON.parse(ctx.claude.requests[1].messages[2].content[0].content);
      expect(result).toMatchObject({
        card: "Casa Azul, Tulum · sleeps 6 · 2 BR · ★4.92 · Free cancellation before Mar 1 · airbnb.com/rooms/111",
        missing: ["price"],
        posted_by: "Jake",
      });
      expect(result.option_id).toBeTruthy();
    });

    it("saves what it read on the option", async () => {
      const [option] = await ctx.store.listOptions(ctx.group.id);
      expect(option!.parsed).toMatchObject({ title: "Casa Azul", sleeps: 6, photoUrl: "https://img.test/casa.jpg" });
      expect(option!.parsed).toHaveProperty("fetchedAt");
    });

    it("sends the listing as a card after the reply: a link that previews as the card and opens the listing", async () => {
      const [line, cardLine] = ctx.nodLines();
      expect(line!.text).toMatch(/^Casa Azul/);
      expect(line!.mediaUrls).toEqual([]);
      expect(cardLine!.text).toMatch(/^https:\/\/nod\.test\/o\/[A-Za-z0-9]{12}$/);
      const card = (await ctx.store.getCard(cardLine!.text.split("/o/")[1]!))!;
      expect(card).toMatchObject({ photoUrl: "https://img.test/casa.jpg", targetUrl: "https://www.airbnb.com/rooms/111" });
      expect(card.data).toMatchObject({ source: "Airbnb", title: "Casa Azul" });
      expect(card.data.number).toBeUndefined();
    });
  });

  it("reuses a recent read instead of fetching again, and sends one card per listing when comparing", async () => {
    const claude = fakeClaude(
      reply([toolUse("a", "parse_listing", { url: "https://www.airbnb.com/rooms/111" })], "tool_use"),
      reply([text("Casa Azul looks good.")]),
      reply(
        [toolUse("b", "parse_listing", { url: "https://www.airbnb.com/rooms/111" }), toolUse("c", "parse_listing", { url: "https://www.airbnb.com/rooms/222" })],
        "tool_use",
      ),
      reply([text("Casa Azul sleeps 6; Jungle Loft is 1 BR.")]),
    );
    ctx = await setup(claude);
    await ctx.say("will", "@Nod check https://www.airbnb.com/rooms/111");
    await ctx.say("will", "@Nod compare with https://www.airbnb.com/rooms/222");

    expect(ctx.fetchListing.mock.calls.map((c) => c[0])).toEqual(["https://www.airbnb.com/rooms/111", "https://www.airbnb.com/rooms/222"]);
    const lines = ctx.nodLines().map((l) => l.text);
    // first reply + its card, then the comparison + two cards
    expect(lines).toHaveLength(5);
    expect(lines.slice(3).every((t) => /\/o\/[A-Za-z0-9]{12}$/.test(t))).toBe(true);
  });

  it("tells Claude when a page can't be read, so it asks the poster", async () => {
    const claude = fakeClaude(
      reply([toolUse("t1", "parse_listing", { url: "https://www.vrbo.com/555" })], "tool_use"),
      reply([text("I couldn't open that one. Jake, can you send the price, beds and cancellation policy?")]),
    );
    ctx = await setup(claude);
    await ctx.say("jake", "@Nod https://www.vrbo.com/555");
    const result = JSON.parse(claude.requests[1].messages[2].content[0].content);
    expect(result).toMatchObject({
      card: "vrbo.com/555",
      read_page: false,
      missing: ["price", "sleeps", "bedrooms", "cancellation policy"],
      posted_by: "Jake",
    });
    const [option] = await ctx.store.listOptions(ctx.group.id);
    expect(option!.parsed).toHaveProperty("fetchError");
  });

  describe("update_option", () => {
    it("records details people give, in integer cents", async () => {
      const optionIdFrom = (body: any) => /\[option ([^\]]+)\]/.exec(body.messages[0].content)![1];
      const claude = fakeClaude(
        (body) =>
          reply(
            [toolUse("u", "update_option", { option_id: optionIdFrom(body), price_cents: 31000, price_per: "night", currency: "USD", sleeps: 6 })],
            "tool_use",
          ),
        reply([text("Got it.")]),
      );
      ctx = await setup(claude);
      await ctx.say("jake", "https://www.airbnb.com/rooms/111");
      await ctx.say("jake", "@Nod it's $310 a night, sleeps 6");

      expect(claude.requests[1].messages[2].content[0]).toMatchObject({ is_error: false, content: expect.stringContaining("$310/night") });
      const [option] = await ctx.store.listOptions(ctx.group.id);
      expect(option!.parsed).toMatchObject({ price: { amountCents: 31000, currency: "USD", per: "night" }, sleeps: 6 });
    });

    it("only touches options in this group", async () => {
      const claude = fakeClaude(
        reply([toolUse("u", "update_option", { option_id: "nope", sleeps: 2 })], "tool_use"),
        reply([text("Hmm.")]),
      );
      ctx = await setup(claude);
      await ctx.say("will", "@Nod sleeps 2");
      expect(claude.requests[1].messages[2].content[0]).toMatchObject({ is_error: true, content: "That option isn't in this group." });
    });
  });
});

describe("sample listings (web simulator)", () => {
  it("serves marked sample pages for the sample links and refuses everything else", async () => {
    const html = await sampleListingFetcher(SAMPLE_LISTINGS[0]!.url);
    expect(html).toContain("og:title");
    await expect(sampleListingFetcher("https://www.airbnb.com/rooms/1")).rejects.toThrow(/simulator/);
  });
});
