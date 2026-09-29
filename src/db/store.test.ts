import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb, type TestDb } from "./testing";
import { MessageStore, type SaveMessageInput } from "./store";

let db: TestDb;
let now: Date;
let store: MessageStore;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  now = new Date("2026-09-29T12:00:00Z");
  store = new MessageStore(db, { now: () => now });
});

async function groupWith(...phones: string[]) {
  const { group } = await store.upsertGroup({ provider: "test", providerGroupId: "pg1", name: "Tulum" });
  const users = await Promise.all(phones.map((p) => store.upsertUser(p)));
  await store.addMembers(group.id, users.map((u) => u.id));
  return { group, users };
}

function input(over: Partial<SaveMessageInput>): SaveMessageInput {
  return {
    provider: "test",
    providerMessageId: `pm-${Math.random()}`,
    groupId: null,
    dmUserId: null,
    senderUserId: null,
    fromNod: false,
    text: "hello",
    mediaUrls: [],
    service: "imessage",
    replyToProviderMessageId: null,
    addressed: false,
    createdAt: now,
    ...over,
  };
}

describe("users and groups", () => {
  it("upserts users by phone", async () => {
    const a = await store.upsertUser("+15550200001");
    const b = await store.upsertUser("+15550200001");
    expect(b.id).toBe(a.id);
    expect(a.accessStatus).toBe("waitlist");
  });

  it("upserts groups by provider group id and reports first sight", async () => {
    const first = await store.upsertGroup({ provider: "test", providerGroupId: "pg1", name: "Tulum" });
    const again = await store.upsertGroup({ provider: "test", providerGroupId: "pg1" });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.group.id).toBe(first.group.id);
    expect(again.group.name).toBe("Tulum");
  });

  it("adds members idempotently and tracks opt-out", async () => {
    const { group, users } = await groupWith("+15550200001", "+15550200002");
    await store.addMembers(group.id, [users[0]!.id]);
    expect(await store.isOptedOut(group.id, users[0]!.id)).toBe(false);
    await store.setOptedOut(group.id, users[0]!.id, true);
    expect(await store.isOptedOut(group.id, users[0]!.id)).toBe(true);
  });
});

describe("messages", () => {
  it("saves once per provider message id (webhook retries)", async () => {
    const { group, users } = await groupWith("+15550200001");
    const m = input({ providerMessageId: "pm1", groupId: group.id, senderUserId: users[0]!.id });
    expect(await store.saveMessage(m)).toMatchObject({ saved: true, duplicate: false });
    expect(await store.saveMessage(m)).toMatchObject({ saved: false, duplicate: true });
    expect(await store.hasMessage("test", "pm1")).toBe(true);
  });

  it("knows which messages Nod sent", async () => {
    const { group } = await groupWith("+15550200001");
    await store.saveMessage(input({ providerMessageId: "nod1", groupId: group.id, fromNod: true, text: "Will added me." }));
    expect(await store.isFromNod("test", "nod1")).toBe(true);
    expect(await store.isFromNod("test", "unknown")).toBe(false);
  });

  it("returns recent group messages oldest-first with sender names, skipping opted-out members", async () => {
    const { group, users } = await groupWith("+15550200001", "+15550200002");
    await store.setUserName(users[0]!.id, "Will");
    for (const [i, [u, text]] of ([[0, "one"], [1, "two"], [0, "three"]] as const).entries()) {
      now = new Date(Date.UTC(2026, 8, 29, 12, i));
      await store.saveMessage(input({ groupId: group.id, senderUserId: users[u]!.id, text }));
    }
    now = new Date(Date.UTC(2026, 8, 29, 12, 5));
    await store.saveMessage(input({ groupId: group.id, fromNod: true, text: "hi all" }));

    expect(await store.recentMessages({ groupId: group.id }, 3)).toEqual([
      { from: "+15550200002", text: "two" },
      { from: "Will", text: "three" },
      { from: "Nod", text: "hi all" },
    ]);

    await store.setOptedOut(group.id, users[1]!.id, true);
    expect((await store.recentMessages({ groupId: group.id }, 10)).map((m) => m.text)).toEqual(["one", "three", "hi all"]);
  });

  it("keeps private threads separate per person", async () => {
    const a = await store.upsertUser("+15550200001");
    const b = await store.upsertUser("+15550200002");
    await store.saveMessage(input({ dmUserId: a.id, senderUserId: a.id, text: "from a" }));
    await store.saveMessage(input({ dmUserId: b.id, senderUserId: b.id, text: "from b" }));
    await store.saveMessage(input({ dmUserId: a.id, fromNod: true, text: "to a" }));
    expect((await store.recentMessages({ dmUserId: a.id }, 10)).map((m) => m.text)).toEqual(["from a", "to a"]);
  });
});

describe("retention (last 200 messages or 30 days, whichever is smaller)", () => {
  it("keeps only the newest 200 messages per group", async () => {
    const { group, users } = await groupWith("+15550200001");
    const other = await store.upsertGroup({ provider: "test", providerGroupId: "pg2" });
    await store.saveMessage(input({ groupId: other.group.id, senderUserId: users[0]!.id, text: "other group" }));
    for (let i = 0; i < 205; i++) {
      now = new Date(Date.UTC(2026, 8, 29, 12, 0, i));
      await store.saveMessage(input({ groupId: group.id, senderUserId: users[0]!.id, text: `m${i}` }));
    }
    const kept = await store.recentMessages({ groupId: group.id }, 1000);
    expect(kept).toHaveLength(200);
    expect(kept[0]!.text).toBe("m5");
    expect(await store.recentMessages({ groupId: other.group.id }, 10)).toHaveLength(1);
  });

  it("drops messages older than 30 days", async () => {
    const { group, users } = await groupWith("+15550200001");
    now = new Date("2026-08-01T00:00:00Z");
    await store.saveMessage(input({ groupId: group.id, senderUserId: users[0]!.id, text: "old" }));
    now = new Date("2026-09-29T00:00:00Z");
    await store.saveMessage(input({ groupId: group.id, senderUserId: users[0]!.id, text: "new" }));
    expect((await store.recentMessages({ groupId: group.id }, 10)).map((m) => m.text)).toEqual(["new"]);
  });

  it("applies the same limits to private threads", async () => {
    const a = await store.upsertUser("+15550200001");
    for (let i = 0; i < 203; i++) {
      now = new Date(Date.UTC(2026, 8, 29, 12, 0, i));
      await store.saveMessage(input({ dmUserId: a.id, senderUserId: a.id, text: `d${i}` }));
    }
    expect(await store.recentMessages({ dmUserId: a.id }, 1000)).toHaveLength(200);
  });
});

describe("reactions", () => {
  it("stores one tapback per person on a message, replacing and removing", async () => {
    const { group, users } = await groupWith("+15550200001", "+15550200002");
    await store.saveMessage(input({ providerMessageId: "t1", groupId: group.id, senderUserId: users[0]!.id }));
    const [a, b] = users;

    expect(await store.setReaction({ provider: "test", targetProviderMessageId: "t1", userId: b!.id, reaction: "like", removed: false })).toBe(true);
    await store.setReaction({ provider: "test", targetProviderMessageId: "t1", userId: b!.id, reaction: "like", removed: false });
    await store.setReaction({ provider: "test", targetProviderMessageId: "t1", userId: a!.id, reaction: "love", removed: false });
    expect(await store.reactionsFor("test", "t1")).toEqual({ [a!.id]: "love", [b!.id]: "like" });

    await store.setReaction({ provider: "test", targetProviderMessageId: "t1", userId: b!.id, reaction: "dislike", removed: false });
    await store.setReaction({ provider: "test", targetProviderMessageId: "t1", userId: a!.id, reaction: "love", removed: true });
    expect(await store.reactionsFor("test", "t1")).toEqual({ [b!.id]: "dislike" });
  });

  it("ignores tapbacks on messages Nod never saw", async () => {
    const u = await store.upsertUser("+15550200001");
    expect(await store.setReaction({ provider: "test", targetProviderMessageId: "pre-join", userId: u.id, reaction: "like", removed: false })).toBe(false);
  });
});
