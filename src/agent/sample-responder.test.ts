import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../db/memory-store";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import { createNod } from "../nod";
import { SNAG_MESSAGE } from "./responder";
import { createSampleClassifier, createSampleResponder, NO_REPLY, type SampleFn } from "./sample-responder";
import { sendPrivateMessage } from "./tools/private-message";

function fakeSample(impl: (input: unknown, opts: any) => Promise<{ text: string; truncated: boolean }>) {
  const fn = vi.fn(impl) as unknown as SampleFn & ReturnType<typeof vi.fn>;
  (fn as any).json = vi.fn(async () => ({ addressed: true }));
  return fn;
}

async function setup(sample: SampleFn, onUnavailable?: (code: string) => void) {
  const world = new ChatWorld();
  const store = new MemoryStore();
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4" },
    makeResponder: (env) => createSampleResponder({ ...env, sample, tools: [sendPrivateMessage], onUnavailable }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const ask = async (text: string) => {
    world.say(s.users.will.id, s.groupId, text, { mentionNod: true });
    await world.settled();
  };
  const nodLines = () => world.transcript(s.groupId, s.users.will.id).filter((l) => l.from === "nod").slice(1);
  return { world, store, s, ask, nodLines };
}

describe("sample responder (web simulator)", () => {
  it("sends the rules and the context in one prompt, uncached, and posts the reply", async () => {
    const sample = fakeSample(async () => ({ text: "The pool house is cheaper.", truncated: false }));
    const ctx = await setup(sample);
    await ctx.ask("@Nod which is cheaper?");

    const [input, opts] = (sample as any).mock.calls[0];
    expect(typeof input).toBe("string");
    expect(input).toContain("You are Nod");
    expect(input).toContain(NO_REPLY);
    expect(input).toContain('<message from="Will">\n@Nod which is cheaper?\n</message>');
    expect(opts.cache).toBe(false);
    expect(opts.tools.map((t: any) => t.name)).toEqual(["send_private_message"]);
    expect(ctx.nodLines().map((l) => l.text)).toEqual(["The pool house is cheaper."]);
  });

  it("runs Nod's tools from the page, throwing tool errors back to Claude", async () => {
    const sample = fakeSample(async (_input, opts) => {
      const tool = opts.tools[0];
      await expect(tool.execute({ to: "Nobody", text: "hi" }, {})).rejects.toThrow("No one named “Nobody” is in this group.");
      expect(await tool.execute({ to: "Jake", text: "You owe $120." }, {})).toBe("Sent privately to Jake.");
      return { text: "I messaged Jake.", truncated: false };
    });
    const ctx = await setup(sample);
    await ctx.ask("@Nod remind Jake what he owes");

    expect(ctx.world.dmTranscript(ctx.s.users.jake.id).at(-1)).toMatchObject({ from: "nod", text: "You owe $120." });
    expect(ctx.nodLines().map((l) => l.text)).toEqual(["I messaged Jake."]);
  });

  it("opens a follow-up window for the caller when the reply asks them something", async () => {
    const sample = fakeSample(async () => ({ text: "Want me to search for dinner too?", truncated: false }));
    const ctx = await setup(sample);
    await ctx.ask("@Nod which is cheaper?");
    const group = (await ctx.store.groupByProviderId("simulator", ctx.s.groupId))!;
    const will = await ctx.store.upsertUser(ctx.s.users.will.phone);
    expect(await ctx.store.activePendingQuestion(group.id, will.id, new Date(Date.now() + 60_000))).toMatchObject({
      question: "Want me to search for dinner too?",
    });
  });

  it("stays silent on NO_REPLY, an empty completion, or a refusal", async () => {
    for (const outcome of [
      async () => ({ text: ` ${NO_REPLY} `, truncated: false }),
      async () => Promise.reject({ code: "empty_completion", message: "" }),
      async () => Promise.reject({ code: "refused", message: "" }),
    ]) {
      const ctx = await setup(fakeSample(outcome));
      await ctx.ask("@Nod hmm");
      expect(ctx.nodLines()).toEqual([]);
    }
  });

  it("reports when Claude isn't available to this viewer, without posting anything", async () => {
    const onUnavailable = vi.fn();
    const ctx = await setup(fakeSample(async () => Promise.reject({ code: "not_granted", message: "" })), onUnavailable);
    await ctx.ask("@Nod hi");
    expect(onUnavailable).toHaveBeenCalledWith("not_granted");
    expect(ctx.nodLines()).toEqual([]);
  });

  it("apologizes once on other failures", async () => {
    const ctx = await setup(fakeSample(async () => Promise.reject({ code: "upstream_error", message: "" })));
    await ctx.ask("@Nod hi");
    expect(ctx.nodLines().map((l) => l.text)).toEqual([SNAG_MESSAGE]);
  });
});

describe("sample classifier", () => {
  it("asks for JSON on the quick tier and answers true only on a clear yes", async () => {
    const sample = fakeSample(async () => ({ text: "", truncated: false }));
    const json = (sample as any).json as ReturnType<typeof vi.fn>;
    const classify = createSampleClassifier(sample);

    json.mockResolvedValueOnce({ addressed: true });
    expect(await classify({ text: "should we ask nod", recent: [{ from: "Jake", text: "who books?" }] })).toBe(true);
    const [prompt, opts] = json.mock.calls[0]!;
    expect(prompt).toContain("Is this message addressed to the assistant named Nod?");
    expect(prompt).toContain("Jake: who books?");
    expect(opts).toEqual({ modelTier: "quick", cache: false });

    json.mockResolvedValueOnce({ addressed: "yes" });
    expect(await classify({ text: "x nod", recent: [] })).toBe(false);
    json.mockRejectedValueOnce({ code: "not_granted" });
    await expect(classify({ text: "x nod", recent: [] })).rejects.toBeTruthy(); // isAddressedToNod turns this into silence
  });
});
