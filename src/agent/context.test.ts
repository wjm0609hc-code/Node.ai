import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../db/memory-store";
import type { AddressedCall } from "../inbound/pipeline";
import type { InboundMessage } from "../messaging/types";
import { buildContext, displayName } from "./context";

const NOD = "+15550100000";
let store: MemoryStore;
let group: { id: string };
let will: { id: string }, jake: { id: string }, anon: { id: string };

function call(over: Partial<InboundMessage> = {}, groupId: string | null = group.id): AddressedCall {
  return {
    event: {
      type: "message",
      provider: "test",
      messageId: "m-now",
      groupId: groupId ? "pg-1" : null,
      from: "+15550200001",
      text: "@Nod which one is cheaper?",
      mediaUrls: [],
      service: "imessage",
      mentions: [],
      sentAt: new Date("2026-09-29T15:00:00Z"),
      ...over,
    },
    decision: { addressed: true, tier: "certain", reason: "mention" },
    groupId,
    senderUserId: will.id,
    firstSeenGroup: false,
  };
}

beforeEach(async () => {
  store = new MemoryStore({ now: () => new Date("2026-09-29T15:00:00Z") });
  will = await store.upsertUser("+15550200001");
  jake = await store.upsertUser("+15550200002");
  anon = await store.upsertUser("+15550200003");
  await store.setUserName(will.id, "Will");
  await store.setUserName(jake.id, "Jake");
  group = (await store.upsertGroup({ provider: "test", providerGroupId: "pg-1", name: "Tulum" })).group;
  await store.addMembers(group.id, [will.id, jake.id, anon.id]);
  await store.setGroupJoined(group.id, new Date("2026-09-28T10:00:00Z"));
  const save = (sender: string | null, text: string, i: number, fromNod = false) =>
    store.saveMessage({
      provider: "test",
      providerMessageId: i === 4 ? "m-now" : `p${i}`, // the message being answered is already stored
      groupId: group.id,
      dmUserId: null,
      senderUserId: sender,
      fromNod,
      text,
      mediaUrls: [],
      service: "imessage",
      replyToProviderMessageId: null,
      addressed: false,
      createdAt: new Date(Date.UTC(2026, 8, 29, 14, i)),
    });
  await save(jake.id, "https://airbnb.com/rooms/111 has a pool", 1);
  await save(anon.id, "https://airbnb.com/rooms/222 is closer", 2);
  await save(null, "Sarah added me. Tag @Nod when you need me.", 3, true);
  await save(will.id, "@Nod which one is cheaper?", 4);
});

describe("buildContext", () => {
  it("describes the chat, the recent messages and the new message, without phone numbers", async () => {
    const { userText, chat, caller } = await buildContext(call(), { store, selfPhone: NOD, now: () => new Date("2026-09-29T15:00:00Z") });

    expect(caller).toMatchObject({ userId: will.id, name: "Will" });
    expect(chat).toMatchObject({ kind: "group", groupId: group.id, providerGroupId: "pg-1", name: "Tulum" });
    expect(userText).toContain("Today is Tuesday, September 29, 2026.");
    expect(userText).toContain("Group chat “Tulum” (iMessage). Members: Will, Jake, Member ending 0003.");
    expect(userText).toContain("You joined on September 28, 2026");
    const recent = userText.slice(userText.indexOf("<recent_messages>"), userText.indexOf("</recent_messages>"));
    expect(recent.split("\n").filter(Boolean).slice(1)).toEqual([
      "Jake: https://airbnb.com/rooms/111 has a pool",
      "Member ending 0003: https://airbnb.com/rooms/222 is closer",
      "Nod: Sarah added me. Tag @Nod when you need me.",
    ]);
    expect(userText).toContain('<message from="Will">\n@Nod which one is cheaper?\n</message>');
    expect(userText).not.toMatch(/\+1555/);
  });

  it("describes a private chat", async () => {
    const { userText, chat } = await buildContext(call({ groupId: null, text: "hi" }, null), { store, selfPhone: NOD });
    expect(chat).toEqual({ kind: "private" });
    expect(userText).toContain("Private chat with Will.");
    expect(userText).toContain('<message from="Will">\nhi\n</message>');
  });

  it("adds sections from context providers and skips empty ones", async () => {
    const { userText } = await buildContext(call(), {
      store,
      selfPhone: NOD,
      sections: [async () => ({ title: "group_notes", body: "Jake is vegetarian." }), async () => null],
    });
    expect(userText).toContain("<group_notes>\nJake is vegetarian.\n</group_notes>");
  });

  it("notes shared contact cards and attachments", async () => {
    const { userText } = await buildContext(
      call({ mediaUrls: ["https://cdn/x.jpg"], contactCards: [{ name: "Priya", phone: "+15550200009" }] }),
      { store, selfPhone: NOD },
    );
    expect(userText).toContain("[1 attachment]");
    expect(userText).toContain("[shared contact: Priya]");
    expect(userText).not.toContain("+15550200009");
  });
});

describe("displayName", () => {
  it("uses the name, or the last four digits", () => {
    expect(displayName({ name: "Will", phone: "+15550200001" })).toBe("Will");
    expect(displayName({ name: null, phone: "+15550200003" })).toBe("Member ending 0003");
  });
});
