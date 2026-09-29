import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../db/memory-store";
import { silentLogger } from "../../lib/log";
import type { Destination, MessagingProvider, OutboundContent } from "../../messaging/types";
import { createToolRegistry, type ToolContext } from "../tools";
import { sendPrivateMessage } from "./private-message";

class Outbox implements MessagingProvider {
  readonly name = "test";
  readonly selfPhone = "+15550100000";
  sent: Array<{ to: Destination; content: OutboundContent }> = [];
  onInbound() {
    return () => {};
  }
  async send(to: Destination, content: OutboundContent) {
    this.sent.push({ to, content });
    return { messageId: `o${this.sent.length}`, service: "imessage" as const };
  }
  async createGroup(): Promise<never> {
    throw new Error("no");
  }
}

let outbox: Outbox;
let ctx: ToolContext;
const registry = createToolRegistry([sendPrivateMessage]);

beforeEach(() => {
  outbox = new Outbox();
  const members = [
    { userId: "u1", name: "Will", phone: "+15550200001", optedOut: false },
    { userId: "u2", name: "Jake Miller", phone: "+15550200002", optedOut: false },
    { userId: "u3", name: "Jake Ortiz", phone: "+15550200003", optedOut: false },
    { userId: "u4", name: null, phone: "+15550200004", optedOut: false },
  ];
  ctx = {
    store: new MemoryStore(),
    provider: outbox,
    logger: silentLogger,
    chat: { kind: "group", groupId: "g1", providerGroupId: "pg1", name: "Tulum" },
    caller: { userId: "u1", name: "Will", phone: "+15550200001" },
    members,
  };
});

describe("send_private_message", () => {
  it("messages a member of the current group privately", async () => {
    const r = await registry.run("send_private_message", { to: "Jake Miller", text: "You owe $120 for the house." }, ctx);
    expect(r).toEqual({ content: "Sent privately to Jake Miller.", isError: false });
    expect(outbox.sent).toEqual([{ to: { phone: "+15550200002" }, content: { text: "You owe $120 for the house." } }]);
  });

  it("matches a member by the label Nod sees for unnamed people", async () => {
    await registry.run("send_private_message", { to: "Member ending 0004", text: "hi" }, ctx);
    expect(outbox.sent[0]!.to).toEqual({ phone: "+15550200004" });
  });

  it("asks for a full name when a first name is ambiguous", async () => {
    const r = await registry.run("send_private_message", { to: "Jake", text: "hi" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toBe("More than one member matches “Jake”: Jake Miller, Jake Ortiz. Use their full name.");
    expect(outbox.sent).toEqual([]);
  });

  it("only reaches people in this group", async () => {
    const r = await registry.run("send_private_message", { to: "Priya", text: "hi" }, ctx);
    expect(r).toEqual({ content: "No one named “Priya” is in this group.", isError: true });
  });

  it("isn't available in a private chat", async () => {
    const r = await registry.run("send_private_message", { to: "Will", text: "hi" }, { ...ctx, chat: { kind: "private" } });
    expect(r).toEqual({ content: "Private messages can only be sent from a group chat. Just reply here.", isError: true });
  });
});
