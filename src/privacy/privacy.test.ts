import { describe, expect, it, vi } from "vitest";
import { createResponder, type AgentClient } from "../agent/responder";
import { MemoryStore } from "../db/memory-store";
import { silentLogger } from "../lib/log";
import { registerWorldPeople } from "../messaging/simulator/directory";
import { seedTulumGroup } from "../messaging/simulator/scenarios";
import { ChatWorld } from "../messaging/simulator/world";
import { createNod } from "../nod";

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[], stop_reason = "end_turn") => ({ stop_reason, content });
type Scripted = ReturnType<typeof reply>;
const call = (name: string, input: Record<string, unknown>, after = "Done."): Scripted[] => [
  reply([toolUse("t", name, input)], "tool_use"),
  reply(after ? [text(after)] : []),
];
type Who = "will" | "jake" | "sarah" | "mike";

async function setup(responses: Scripted[] = []) {
  const now = () => new Date("2026-09-29T15:00:00Z");
  const world = new ChatWorld({ now });
  const store = new MemoryStore({ now });
  const requests: any[] = [];
  const create = vi.fn(async (body: any) => {
    requests.push(structuredClone(body));
    return responses.shift() ?? reply([text("ok")]);
  });
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: async () => false,
    logger: silentLogger,
    config: { howToVideoUrl: "https://nod.test/v.mp4", appUrl: "https://nod.test", timezone: "America/New_York" },
    now,
    makeResponder: (env) => createResponder({ ...env, client: { beta: { messages: { create } } } as unknown as AgentClient }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));
  const s = seedTulumGroup(world);
  await registerWorldPeople(world, store, { access: "active" });
  world.addNod(s.groupId, s.users.sarah.id);
  await world.settled();
  const group = (await store.groupByProviderId("simulator", s.groupId))!;
  const idOf = async (who: Who) => (await store.upsertUser(s.users[who].phone)).id;
  const say = async (who: Who, message: string) => {
    world.say(s.users[who].id, s.groupId, message, { mentionNod: message.includes("@Nod") });
    await world.settled();
  };
  const lastToolResult = () => {
    const msgs = requests.at(-1).messages;
    return msgs[msgs.length - 1].content[0].content as string;
  };
  const lastDm = (who: Who) => world.dmTranscript(s.users[who].id).filter((l) => l.from === "nod").at(-1)?.text ?? "";
  const context = () => String(requests.at(-1).messages[0].content);
  return { world, store, nod, s, group, idOf, say, lastToolResult, lastDm, context, requests };
}

describe("stopping Nod reading your messages", () => {
  it("opts the caller out in the group, deletes what Nod stored from them, and Claude stops seeing them", async () => {
    const ctx = await setup([...call("set_message_reading", { read: false }, "Got it, Jake."), reply([text("ok")])]);
    await ctx.say("jake", "the secret beach is past the second gate");
    await ctx.say("mike", "nice");
    await ctx.say("jake", "@Nod please don't read my messages");
    expect(ctx.lastToolResult()).toBe("Nod no longer reads Jake's messages in this chat, and deleted 2 stored messages. They can still tag Nod, vote and pay.");
    expect(await ctx.store.isOptedOut(ctx.group.id, await ctx.idOf("jake"))).toBe(true);

    await ctx.say("jake", "meet at the dock at 9");
    await ctx.say("will", "@Nod what's the plan?");
    expect(ctx.context()).not.toMatch(/secret beach|dock at 9|don't read my messages/);
    expect(ctx.context()).toMatch(/nice/);
  });

  it("still answers when an opted-out member tags Nod", async () => {
    const ctx = await setup([...call("set_message_reading", { read: false }), reply([text("Sure.")])]);
    await ctx.say("jake", "@Nod opt me out");
    const before = ctx.requests.length;
    await ctx.say("jake", "@Nod what's on the tab?");
    expect(ctx.requests.length).toBe(before + 1);
    expect(ctx.context()).toMatch(/what's on the tab/);
  });

  it("turns reading back on", async () => {
    const ctx = await setup([...call("set_message_reading", { read: false }), ...call("set_message_reading", { read: true })]);
    await ctx.say("jake", "@Nod don't read my messages");
    await ctx.say("jake", "@Nod ok you can read my messages again");
    expect(ctx.lastToolResult()).toBe("Nod reads Jake's messages in this chat again.");
    expect(await ctx.store.isOptedOut(ctx.group.id, await ctx.idOf("jake"))).toBe(false);
  });

  it("from a private chat, applies to every group shared with Nod", async () => {
    const ctx = await setup(call("set_message_reading", { read: false }, ""));
    ctx.world.dm(ctx.s.users.mike.id, "stop reading my messages everywhere");
    await ctx.world.settled();
    expect(ctx.lastToolResult()).toMatch(/^Nod no longer reads Mike's messages in Tulum/);
    expect(await ctx.store.isOptedOut(ctx.group.id, await ctx.idOf("mike"))).toBe(true);
  });
});

describe("the settings page", () => {
  async function withLink() {
    const ctx = await setup([
      ...call("remember_group_note", { note: "vegetarian", about: "Mike", kind: "must_have" }),
      ...call("settings_link", {}, "Sent you your settings privately."),
    ]);
    await ctx.say("will", "@Nod remember Mike's vegetarian");
    await ctx.say("jake", "@Nod where are my settings?");
    expect(ctx.lastToolResult()).toBe("Sent Jake their settings link privately.");
    const link = /https:\/\/nod\.test\/group\/([^/]+)\/settings\?t=([\w-]+)/.exec(ctx.lastDm("jake"))!;
    expect(link[1]).toBe(ctx.group.id);
    const groupText = ctx.world.transcript(ctx.s.groupId, ctx.s.users.will.id).map((l) => l.text).join("\n");
    expect(groupText).not.toContain("/settings?t=");
    return { ...ctx, token: decodeURIComponent(link[2]!) };
  }

  it("shows the organizer, the spending rule, notes and the reading switch, only with the right token", async () => {
    const ctx = await withLink();
    const page = await ctx.nod.privacy.settingsPage(ctx.group.id, ctx.token);
    expect(page.status).toBe(200);
    expect(page.html).toContain("Settings for Jake");
    expect(page.html).toContain("No organizer set, so Sarah approves spending. Over $200 per person needs 3 approvals.");
    expect(page.html).toContain("Mike: vegetarian");
    expect(page.html).toContain("Stop reading my messages");
    expect((await ctx.nod.privacy.settingsPage(ctx.group.id, "wrong")).status).toBe(404);
    expect((await ctx.nod.privacy.settingsPage(ctx.group.id, null)).status).toBe(404);
    expect((await ctx.nod.privacy.settingsPage("another-group", ctx.token)).status).toBe(404);
  });

  it("opts out and back in, and deletes notes", async () => {
    const ctx = await withLink();
    const jake = await ctx.idOf("jake");
    let page = await ctx.nod.privacy.settingsAction(ctx.group.id, ctx.token, "opt_out", null);
    expect(page.html).toMatch(/Done\. Nod won&#39;t read your messages here, and deleted \d+ stored messages?\./);
    expect(page.html).toContain("Let Nod read my messages again");
    expect(await ctx.store.isOptedOut(ctx.group.id, jake)).toBe(true);
    page = await ctx.nod.privacy.settingsAction(ctx.group.id, ctx.token, "opt_in", null);
    expect(await ctx.store.isOptedOut(ctx.group.id, jake)).toBe(false);

    const [note] = await ctx.store.listGroupNotes(ctx.group.id);
    page = await ctx.nod.privacy.settingsAction(ctx.group.id, ctx.token, "delete_note", note!.id);
    expect(page.html).toContain("Deleted “vegetarian”.");
    expect(await ctx.store.listGroupNotes(ctx.group.id)).toEqual([]);
    expect((await ctx.nod.privacy.settingsAction(ctx.group.id, ctx.token, "delete_note", note!.id)).html).toContain("already deleted");
  });

  it("refuses actions without a valid token or with an unknown action", async () => {
    const ctx = await withLink();
    expect((await ctx.nod.privacy.settingsAction(ctx.group.id, "wrong", "opt_out", null)).status).toBe(404);
    expect(await ctx.store.isOptedOut(ctx.group.id, await ctx.idOf("jake"))).toBe(false);
    expect((await ctx.nod.privacy.settingsAction(ctx.group.id, ctx.token, "forget_everything", null)).status).toBe(400);
  });

  it("escapes what people typed", async () => {
    const ctx = await setup([...call("remember_group_note", { note: "<script>alert(1)</script>", kind: "preference" }), ...call("settings_link", {})]);
    await ctx.say("will", "@Nod remember this");
    await ctx.say("will", "@Nod settings");
    const token = decodeURIComponent(/settings\?t=([\w-]+)/.exec(ctx.lastDm("will"))![1]!);
    const page = await ctx.nod.privacy.settingsPage(ctx.group.id, token);
    expect(page.html).not.toContain("<script>alert");
    expect(page.html).toContain("&lt;script&gt;");
  });
});

describe("delivery_link", () => {
  it("returns a search link and says it isn't an order", async () => {
    const ctx = await setup(call("delivery_link", { service: "instacart", items: ["2 bags of ice", "limes"], address: "the rental" }));
    await ctx.say("will", "@Nod can we get ice and limes delivered to the rental?");
    expect(ctx.lastToolResult()).toBe(
      "Instacart link: https://www.instacart.com/store/s?k=2%20bags%20of%20ice%2C%20limes Items to add: 2 bags of ice, limes. Set the delivery address in the app: the rental. Not an order yet: whoever opens it orders and pays.",
    );
  });
});
