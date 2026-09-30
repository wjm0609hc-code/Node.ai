import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb, type TestDb } from "./testing";
import { DrizzleStore, type SaveMessageInput, type Store } from "./store";
import { MemoryStore } from "./memory-store";

// Every test runs against both implementations: Postgres (via PGlite) and the
// in-memory twin used by the browser simulator.
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});

const impls: Array<[string, (now: () => Date) => Promise<Store>]> = [
  ["postgres", async (now) => {
    await resetTestDb(db);
    return new DrizzleStore(db, { now });
  }],
  ["memory", async (now) => new MemoryStore({ now })],
];

describe.each(impls)("%s store", (_name, make) => {
let now: Date;
let store: Store;

beforeEach(async () => {
  now = new Date("2026-09-29T12:00:00Z");
  store = await make(() => now);
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

describe("onboarding state", () => {
  it("claims the intro once per join and can reset it after Nod is removed", async () => {
    const { group } = await groupWith("+15550200001");
    expect(await store.claimIntro(group.id)).toBe(true);
    expect(await store.claimIntro(group.id)).toBe(false);
    await store.resetIntro(group.id);
    expect(await store.claimIntro(group.id)).toBe(true);
  });

  it("claims personal setup once per person", async () => {
    const u = await store.upsertUser("+15550200001");
    expect(await store.claimSetup(u.id)).toBe(true);
    expect(await store.claimSetup(u.id)).toBe(false);
  });

  it("records who added Nod and access status", async () => {
    const { group, users } = await groupWith("+15550200001");
    await store.setAddedBy(group.id, users[0]!.id);
    expect((await store.getGroup(group.id))?.addedByUserId).toBe(users[0]!.id);
    expect((await store.getUser(users[0]!.id))?.accessStatus).toBe("waitlist");
    await store.setUserAccess(users[0]!.id, "active");
    expect((await store.getUser(users[0]!.id))?.accessStatus).toBe("active");
  });

  it("marks groups Nod created, with the requester as the one who added it", async () => {
    const requester = await store.upsertUser("+15550200001");
    const { group } = await store.upsertGroup({ provider: "test", providerGroupId: "new" });
    await store.markCreatedByNod(group.id, requester.id);
    const g = (await store.getGroup(group.id))!;
    expect(g.createdByNod).toBe(true);
    expect(g.addedByUserId).toBe(requester.id);
    expect(g.joinedAt).toBeInstanceOf(Date);
    expect(await store.claimIntro(group.id)).toBe(false); // the creation message was the intro
  });

  it("finds the latest group a person added Nod to that Nod can't work in", async () => {
    const u = await store.upsertUser("+15550200001");
    const a = (await store.upsertGroup({ provider: "test", providerGroupId: "a", name: "Old" })).group;
    const b = (await store.upsertGroup({ provider: "test", providerGroupId: "b", name: "Brunch" })).group;
    for (const g of [a, b]) await store.setAddedBy(g.id, u.id);
    now = new Date("2026-09-20T12:00:00Z");
    await store.markUnsupported(a.id);
    now = new Date("2026-09-29T12:00:00Z");
    await store.markUnsupported(b.id);
    expect((await store.latestUnsupportedGroupFor(u.id, new Date("2026-09-22T00:00:00Z")))?.name).toBe("Brunch");
    expect(await store.latestUnsupportedGroupFor(u.id, new Date("2026-09-30T00:00:00Z"))).toBeUndefined();
  });
});

describe("known people", () => {
  it("saves shared contact cards per owner and finds them by first or full name", async () => {
    const will = await store.upsertUser("+15550200001");
    const other = await store.upsertUser("+15550200009");
    await store.saveContacts(will.id, [
      { name: "Jake Miller", phone: "+15550200002" },
      { name: "Sarah Chen", phone: "+15550200003" },
    ]);
    await store.saveContacts(will.id, [{ name: "Jake Miller", phone: "+15550200002" }]); // idempotent
    await store.saveContacts(other.id, [{ name: "Mike", phone: "+15550200004" }]);

    expect(await store.findKnownPeople(will.id, "jake")).toEqual([{ name: "Jake Miller", phone: "+15550200002" }]);
    expect(await store.findKnownPeople(will.id, "Sarah Chen")).toEqual([{ name: "Sarah Chen", phone: "+15550200003" }]);
    expect(await store.findKnownPeople(will.id, "Mike")).toEqual([]); // someone else's contact
  });

  it("also knows named people who share a chat with the requester", async () => {
    const { group, users } = await groupWith("+15550200001", "+15550200002");
    await store.setUserName(users[1]!.id, "Priya");
    expect(await store.findKnownPeople(users[0]!.id, "priya")).toEqual([{ name: "Priya", phone: "+15550200002" }]);
    expect(group).toBeTruthy();
  });

  it("returns every match when a name is ambiguous", async () => {
    const will = await store.upsertUser("+15550200001");
    await store.saveContacts(will.id, [
      { name: "Sam Lee", phone: "+15550200005" },
      { name: "Sam Ortiz", phone: "+15550200006" },
    ]);
    expect(await store.findKnownPeople(will.id, "sam")).toHaveLength(2);
  });
});

describe("chat members and context", () => {
  it("lists group members with names and opt-out status", async () => {
    const { group, users } = await groupWith("+15550200001", "+15550200002");
    await store.setUserName(users[0]!.id, "Will");
    await store.setOptedOut(group.id, users[1]!.id, true);
    const members = await store.groupMembers(group.id);
    expect(members.sort((a, b) => a.phone.localeCompare(b.phone))).toEqual([
      { userId: users[0]!.id, name: "Will", phone: "+15550200001", optedOut: false },
      { userId: users[1]!.id, name: null, phone: "+15550200002", optedOut: true },
    ]);
  });

  it("can leave out the message being answered", async () => {
    const { group, users } = await groupWith("+15550200001");
    await store.saveMessage(input({ providerMessageId: "a", groupId: group.id, senderUserId: users[0]!.id, text: "earlier" }));
    await store.saveMessage(input({ providerMessageId: "b", groupId: group.id, senderUserId: users[0]!.id, text: "now" }));
    const recent = await store.recentMessages({ groupId: group.id }, 10, { excludeProviderMessageId: "b" });
    expect(recent.map((m) => m.text)).toEqual(["earlier"]);
  });
});

describe("options", () => {
  it("saves each link once per group and remembers who posted it", async () => {
    const { group, users } = await groupWith("+15550200001", "+15550200002");
    const first = await store.upsertOption({
      groupId: group.id, kind: "rental", source: "link", url: "https://www.airbnb.com/rooms/111",
      postedByUserId: users[0]!.id, providerMessageId: "m1",
    });
    const again = await store.upsertOption({
      groupId: group.id, kind: "rental", source: "link", url: "https://www.airbnb.com/rooms/111",
      postedByUserId: users[1]!.id, providerMessageId: "m2",
    });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.option).toMatchObject({ id: first.option.id, postedByUserId: users[0]!.id, parsed: {} });
  });

  it("lists a group's options oldest first, optionally by kind", async () => {
    const { group } = await groupWith("+15550200001");
    const other = (await store.upsertGroup({ provider: "test", providerGroupId: "pg2" })).group;
    for (const [i, url] of ["https://a.test/1", "https://a.test/2"].entries()) {
      now = new Date(Date.UTC(2026, 8, 29, 12, i));
      await store.upsertOption({ groupId: group.id, kind: "rental", source: "link", url, postedByUserId: null, providerMessageId: null });
    }
    await store.upsertOption({ groupId: group.id, kind: "restaurant", source: "search", url: "https://r.test", postedByUserId: null, providerMessageId: null });
    await store.upsertOption({ groupId: other.id, kind: "rental", source: "link", url: "https://a.test/9", postedByUserId: null, providerMessageId: null });

    expect((await store.listOptions(group.id, { kind: "rental" })).map((o) => o.url)).toEqual(["https://a.test/1", "https://a.test/2"]);
    expect(await store.listOptions(group.id)).toHaveLength(3);
  });

  it("merges parsed details and keeps them per option", async () => {
    const { group } = await groupWith("+15550200001");
    const { option } = await store.upsertOption({ groupId: group.id, kind: "rental", source: "link", url: "https://a.test/1", postedByUserId: null, providerMessageId: null });
    await store.updateOptionParsed(option.id, { title: "Casa Azul", sleeps: 6 });
    await store.updateOptionParsed(option.id, { price: { amountCents: 31000, currency: "USD", per: "night" } });
    expect((await store.getOption(option.id))?.parsed).toEqual({
      title: "Casa Azul",
      sleeps: 6,
      price: { amountCents: 31000, currency: "USD", per: "night" },
    });
    expect(await store.getOption("missing")).toBeUndefined();
  });
});

describe("searches", () => {
  it("saves a search with its results and finds it by id", async () => {
    const { group, users } = await groupWith("+15550200001");
    const saved = await store.createSearch({
      groupId: group.id,
      requestedByUserId: users[0]!.id,
      query: "fun things to do at night",
      location: "Tulum",
      whenText: "Saturday evening",
      results: { picks: [{ name: "Batey" }] },
    });
    expect(await store.getSearch(saved.id)).toMatchObject({
      groupId: group.id,
      query: "fun things to do at night",
      location: "Tulum",
      whenText: "Saturday evening",
      results: { picks: [{ name: "Batey" }] },
    });
    expect(await store.getSearch("not-an-id")).toBeUndefined();
  });

  it("counts recent searches per chat, including private ones", async () => {
    const { group, users } = await groupWith("+15550200001");
    const base = { requestedByUserId: users[0]!.id, query: "q", location: null, whenText: null, results: {} };
    now = new Date("2026-09-29T10:00:00Z");
    await store.createSearch({ ...base, groupId: group.id });
    now = new Date("2026-09-29T11:30:00Z");
    await store.createSearch({ ...base, groupId: group.id });
    await store.createSearch({ ...base, groupId: null });
    const since = new Date("2026-09-29T11:00:00Z");
    expect(await store.countSearchesSince({ groupId: group.id }, since)).toBe(1);
    expect(await store.countSearchesSince({ dmUserId: users[0]!.id }, since)).toBe(1);
  });
});

describe("pending questions (follow-up answers)", () => {
  it("finds the latest open question Nod asked a person in a group", async () => {
    const { group, users } = await groupWith("+15550200001", "+15550200002");
    const [jake, mike] = users;
    const base = { groupId: group.id, remaining: 2, expiresAt: new Date("2026-09-29T12:10:00Z") };
    await store.createPendingQuestion({ ...base, askedUserId: jake!.id, nodProviderMessageId: "n1", question: "old?" });
    now = new Date("2026-09-29T12:01:00Z");
    const latest = await store.createPendingQuestion({ ...base, askedUserId: jake!.id, nodProviderMessageId: "n2", question: "price?" });

    const at = new Date("2026-09-29T12:05:00Z");
    expect(await store.activePendingQuestion(group.id, jake!.id, at)).toMatchObject({ id: latest.id, question: "price?", remaining: 2 });
    expect(await store.activePendingQuestion(group.id, mike!.id, at)).toBeUndefined();
    expect(await store.activePendingQuestion(group.id, jake!.id, new Date("2026-09-29T12:10:01Z"))).toBeUndefined();
  });

  it("stops counting a question once it has no messages left", async () => {
    const { group, users } = await groupWith("+15550200001");
    const q = await store.createPendingQuestion({
      groupId: group.id, askedUserId: users[0]!.id, nodProviderMessageId: "n1", question: "price?",
      remaining: 2, expiresAt: new Date("2026-09-29T13:00:00Z"),
    });
    await store.setPendingQuestionRemaining(q.id, 1);
    expect((await store.activePendingQuestion(group.id, users[0]!.id, now))?.remaining).toBe(1);
    await store.setPendingQuestionRemaining(q.id, 0);
    expect(await store.activePendingQuestion(group.id, users[0]!.id, now)).toBeUndefined();
  });
});

describe("decisions and votes", () => {
  async function withOptions() {
    const { group, users } = await groupWith("+15550200001", "+15550200002", "+15550200003");
    const opts = [];
    for (const url of ["https://a.test/1", "https://a.test/2", "https://a.test/3"]) {
      opts.push((await store.upsertOption({ groupId: group.id, kind: "rental", source: "link", url, postedByUserId: users[0]!.id, providerMessageId: `pm-${url}` })).option);
    }
    return { group, users, opts };
  }

  it("creates a decision with numbered options and finds the open one", async () => {
    const { group, users, opts } = await withOptions();
    const d = await store.createDecision({
      groupId: group.id, kind: "vote", question: "Where to stay?", createdByUserId: users[0]!.id,
      deadlineAt: new Date("2026-09-30T12:00:00Z"), round: 1, parentDecisionId: null, optionIds: [opts[1]!.id, opts[0]!.id],
    });
    expect(d).toMatchObject({ status: "open", round: 1, question: "Where to stay?", winningOptionId: null });
    expect(await store.decisionOptions(d.id)).toEqual([
      { position: 1, optionId: opts[1]!.id },
      { position: 2, optionId: opts[0]!.id },
    ]);
    expect((await store.openDecision(group.id))?.id).toBe(d.id);
    expect(await store.getDecision("nope")).toBeUndefined();
  });

  it("keeps one vote per person, replacing and removing", async () => {
    const { group, users, opts } = await withOptions();
    const d = await store.createDecision({
      groupId: group.id, kind: "vote", question: "q", createdByUserId: null, deadlineAt: null, round: 1, parentDecisionId: null,
      optionIds: opts.map((o) => o.id),
    });
    await store.setVote(d.id, users[0]!.id, opts[0]!.id);
    await store.setVote(d.id, users[1]!.id, opts[0]!.id);
    await store.setVote(d.id, users[0]!.id, opts[2]!.id);
    expect((await store.votesFor(d.id)).map((v) => [v.userId, v.optionId]).sort()).toEqual(
      [[users[0]!.id, opts[2]!.id], [users[1]!.id, opts[0]!.id]].sort(),
    );
    await store.removeVote(d.id, users[1]!.id, opts[1]!.id); // not their vote: no change
    await store.removeVote(d.id, users[1]!.id, opts[0]!.id);
    expect(await store.votesFor(d.id)).toHaveLength(1);
  });

  it("updates status, winner and deadline, and lists a user's open votes", async () => {
    const { group, users, opts } = await withOptions();
    const d = await store.createDecision({
      groupId: group.id, kind: "vote", question: "q", createdByUserId: null, deadlineAt: null, round: 1, parentDecisionId: null,
      optionIds: [opts[0]!.id, opts[1]!.id],
    });
    expect((await store.openDecisionsForUser(users[2]!.id)).map((x) => x.id)).toEqual([d.id]);
    await store.updateDecision(d.id, { status: "decided", winningOptionId: opts[1]!.id });
    expect(await store.getDecision(d.id)).toMatchObject({ status: "decided", winningOptionId: opts[1]!.id });
    expect(await store.openDecision(group.id)).toBeUndefined();
    expect(await store.openDecisionsForUser(users[2]!.id)).toEqual([]);
  });

  it("finds options and messages for tapback votes", async () => {
    const { group, users, opts } = await withOptions();
    expect((await store.optionByMessage(group.id, "pm-https://a.test/2"))?.id).toBe(opts[1]!.id);
    await store.saveMessage(input({ providerMessageId: "m-text", groupId: group.id, senderUserId: users[0]!.id, text: "https://a.test/3 this one" }));
    expect(await store.findMessageIdByText(group.id, "https://a.test/3 this one")).toBe("m-text");
    expect(await store.findMessageIdByText(group.id, "nothing like it")).toBeUndefined();
  });

  it("stores a group's timezone", async () => {
    const { group } = await groupWith("+15550200001");
    await store.setGroupTimezone(group.id, "America/Cancun");
    expect((await store.getGroup(group.id))?.timezone).toBe("America/Cancun");
  });
});

describe("bookings and events", () => {
  async function withOption() {
    const { group, users } = await groupWith("+15550200001");
    const { option } = await store.upsertOption({ groupId: group.id, kind: "restaurant", source: "search", url: "https://hartwood.test/", postedByUserId: null, providerMessageId: null });
    return { group, users, option };
  }

  it("creates, updates and lists bookings", async () => {
    const { group, users, option } = await withOption();
    const b = await store.createBooking({
      groupId: group.id, optionId: option.id, decisionId: null, requestedByUserId: users[0]!.id, partySize: 6,
      startsAt: new Date("2026-10-04T00:00:00Z"), endsAt: null, allDay: false, link: "https://hartwood.test/", method: "link",
    });
    expect(b).toMatchObject({ status: "link_sent", partySize: 6, bookedByUserId: null, confirmation: {} });
    await store.updateBooking(b.id, { status: "booked", bookedByUserId: users[0]!.id, confirmation: { code: "ABC" } });
    expect(await store.getBooking(b.id)).toMatchObject({ status: "booked", bookedByUserId: users[0]!.id, confirmation: { code: "ABC" } });
    expect((await store.listBookings(group.id)).map((x) => x.id)).toEqual([b.id]);
    expect(await store.getBooking("nope")).toBeUndefined();
  });

  it("tracks a proposal: transitions, approvals and its message", async () => {
    const { group, users, option } = await withOption();
    const approval = { kind: "one_of" as const, userIds: [users[0]!.id] };
    const b = await store.createBooking({
      groupId: group.id, optionId: option.id, decisionId: null, requestedByUserId: users[0]!.id, partySize: 6,
      startsAt: new Date("2026-10-04T00:00:00Z"), endsAt: new Date("2026-10-04T02:00:00Z"), allDay: false, link: null, method: "partner",
      status: "proposed", partner: "sample", holderUserId: users[0]!.id,
      proposal: { slotId: "s1", depositCents: 12000, currency: "USD", freeCancelUntil: null, cancelFeeCents: 0, policy: "", approval },
    });
    expect(b).toMatchObject({ status: "proposed", partner: "sample", proposal: { depositCents: 12000, approval }, reminderSentAt: null });
    expect((await store.openProposal(group.id))?.id).toBe(b.id);

    await store.updateBooking(b.id, { proposalMessageId: "m-1" });
    expect((await store.bookingByProposalMessage(group.id, "m-1"))?.id).toBe(b.id);
    expect(await store.bookingByProposalMessage(group.id, "m-2")).toBeUndefined();

    await store.addBookingApproval(b.id, users[0]!.id);
    await store.addBookingApproval(b.id, users[0]!.id);
    expect(await store.bookingApprovals(b.id)).toEqual([users[0]!.id]);
    await store.removeBookingApproval(b.id, users[0]!.id);
    expect(await store.bookingApprovals(b.id)).toEqual([]);
    await store.addBookingApproval(b.id, users[0]!.id);
    await store.clearBookingApprovals(b.id);
    expect(await store.bookingApprovals(b.id)).toEqual([]);

    // Only one caller gets to move it on.
    expect(await store.transitionBooking(b.id, ["proposed"], { status: "confirming" })).toBe(true);
    expect(await store.transitionBooking(b.id, ["proposed"], { status: "confirming" })).toBe(false);
    expect(await store.openProposal(group.id)).toBeUndefined();
    expect(await store.transitionBooking("nope", ["proposed"], { status: "booked" })).toBe(false);

    expect(await store.claimBookingReminder(b.id)).toBe(true);
    expect(await store.claimBookingReminder(b.id)).toBe(false);
  });

  it("creates and reads calendar events", async () => {
    const { group, option } = await withOption();
    const e = await store.createEvent({
      groupId: group.id, bookingId: null, title: "Dinner", startsAt: new Date("2026-10-04T00:00:00Z"), endsAt: new Date("2026-10-04T02:00:00Z"),
      allDay: false, location: "Tulum", description: null,
    });
    expect(await store.getEvent(e.id)).toMatchObject({ title: "Dinner", allDay: false, location: "Tulum" });
    expect(option).toBeTruthy();
  });
});
});

