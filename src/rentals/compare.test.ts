import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import { createNod } from "../nod";
import { validateMatches, type RentalMatch, type RentalMatcher } from "./matcher";

const CASA = `<meta property="og:title" content="Casa Azul · Condo in Tulum · ★4.92 · 2 bedrooms · 3 beds · 2 baths">
<meta property="og:image" content="https://img.test/casa.jpg"><meta property="og:description" content="Sleeps 6 guests.">`;

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });

async function setup(matches: RentalMatch[] | Error) {
  const world = new ChatWorld();
  const store = new MemoryStore();
  const requests: any[] = [];
  const script: Array<(body: any) => any> = [];
  const create = vi.fn(async (body: any) => {
    requests.push(structuredClone(body));
    return script.shift()?.(body) ?? reply([text("ok")]);
  });
  const matchRental = vi.fn<RentalMatcher>(async () => {
    if (matches instanceof Error) throw matches;
    return { matches };
  });
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4", appUrl: "https://nod.test" },
    fetchListing: async () => CASA,
    matchRental,
    makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const group = (await store.groupByProviderId("simulator", s.groupId))!;
  const { option } = await store.upsertOption({ groupId: group.id, kind: "rental", source: "link", url: "https://www.airbnb.com/rooms/111", postedByUserId: null, providerMessageId: null });
  await store.updateOptionParsed(option.id, { title: "Casa Azul", site: "Airbnb", location: "Tulum", bedrooms: 2, sleeps: 6, price: { amountCents: 31000, currency: "USD", per: "night" } });
  const ask = async (input: Record<string, unknown>) => {
    script.push(() => reply([toolUse("t", "compare_rental", { option_id: option.id, ...input })], "tool_use"), () => reply([text("ok")]));
    world.say(s.users.will.id, s.groupId, "@Nod is this cheaper anywhere?", { mentionNod: true });
    await world.settled();
    const msgs = requests.at(-1).messages;
    return msgs[msgs.length - 1].content[0].content as string;
  };
  return { store, group, option, ask, matchRental, world, s };
}

const VRBO: RentalMatch = { url: "https://www.vrbo.com/1234567", site: "Vrbo", title: "Casa Azul Tulum", evidence: "Same name, host and photos.", price: { amountCents: 28000, currency: "USD", per: "night" } };

describe("compare_rental", () => {
  it("shows the same place on another site as a card, and says how much cheaper only when the prices compare", async () => {
    const ctx = await setup([VRBO, { ...VRBO, url: "https://www.booking.com/hotel/mx/casa-azul.html", site: "Booking.com", price: { amountCents: 200000, currency: "USD", per: "total" } }]);
    const result = JSON.parse(await ctx.ask({ check_in: "2026-12-10", check_out: "2026-12-14", guests: 6 }));
    expect(result.matches).toEqual([
      expect.objectContaining({ site: "Vrbo", price: "$280 a night", cheaper_by: "$30 a night", why_same: "Same name, host and photos." }),
      expect.objectContaining({ site: "Booking.com", price: "$2,000 total" }),
    ]);
    expect(result.matches[1].cheaper_by).toBeUndefined(); // a total can't be compared with a nightly price
    expect(ctx.matchRental).toHaveBeenCalledWith(expect.objectContaining({ url: "https://www.airbnb.com/rooms/111", checkIn: "2026-12-10", checkOut: "2026-12-14", guests: 6 }));
    const saved = await ctx.store.listOptions(ctx.group.id);
    expect(saved.find((o) => o.url === "https://www.vrbo.com/1234567")).toMatchObject({ kind: "rental", source: "search", parsed: expect.objectContaining({ sameAs: ctx.option.id, site: "Vrbo" }) });
    const sent = ctx.world.transcript(ctx.s.groupId, ctx.s.users.will.id).filter((l) => l.from === "nod" && /\/o\//.test(l.text));
    expect(sent).toHaveLength(1); // both matches in one message, with one picture
    expect(sent[0]!.text).toMatch(/^ok\n1 Casa Azul Tulum · https:\/\/nod\.test\/o\/\w{12}\n2 Casa Azul Tulum · https:\/\/nod\.test\/o\/\w{12}$/);
    expect(sent[0]!.mediaUrls[0]).toMatch(/\/o\/s\/\w{12}-\w{12}\/sheet\.png$/);
  });

  it("checks once a day per listing, unless dates are added", async () => {
    const ctx = await setup([VRBO]);
    await ctx.ask({});
    await ctx.ask({});
    expect(ctx.matchRental).toHaveBeenCalledTimes(1);
    await ctx.ask({ check_in: "2026-12-10", check_out: "2026-12-14" });
    expect(ctx.matchRental).toHaveBeenCalledTimes(2);
  });

  it("says nothing turned up, and fails quietly", async () => {
    expect(JSON.parse(await (await setup([])).ask({}))).toMatchObject({ matches: [], note: expect.stringMatching(/Don't mention the check/) });
    expect(await (await setup(new Error("timeout"))).ask({})).toMatch(/Couldn't check other sites right now/);
  });
});

describe("validateMatches", () => {
  const seen = ["https://www.vrbo.com/1234567", "https://www.booking.com/hotel/mx/casa-azul.html?aid=1"];

  it("keeps only listings on the checked sites that appeared in the search", () => {
    const out = validateMatches(
      [
        { url: "https://www.vrbo.com/1234567", title: "Casa Azul", evidence: "same", priceCents: 28000, per: "night" },
        { url: "https://www.booking.com/hotel/mx/casa-azul.html", title: "Casa Azul", evidence: "same" },
        { url: "https://www.vrbo.com/999", title: "Invented", evidence: "same" }, // never in the results
        { url: "https://www.airbnb.com/rooms/111", title: "The original", evidence: "same" },
        { url: "https://evil.example/vrbo.com", title: "Elsewhere", evidence: "same" },
        { url: "https://www.vrbo.com/1234567", title: "No evidence" },
      ],
      [...seen, "https://www.vrbo.com/999x"],
      "https://www.airbnb.com/rooms/111",
    );
    expect(out.map((m) => [m.site, m.url, m.price?.amountCents])).toEqual([
      ["Vrbo", "https://www.vrbo.com/1234567", 28000],
      ["Booking.com", "https://www.booking.com/hotel/mx/casa-azul.html", undefined],
    ]);
  });

  it("drops prices that aren't whole cents or have no unit", () => {
    const [m] = validateMatches([{ url: "https://www.vrbo.com/1234567", title: "x", evidence: "same", priceCents: 280.5, per: "night" }], seen, "https://a.test/");
    expect(m!.price).toBeUndefined();
  });
});
