import { describe, expect, it } from "vitest";
import { ChatWorld } from "./world";
import { seedMixedGroup, seedTulumGroup } from "./scenarios";

describe("seeded scenarios", () => {
  it("Tulum: an all-iPhone group with prior history that can add Nod", async () => {
    const world = new ChatWorld();
    const received: string[] = [];
    world.provider().onInbound((e) => {
      received.push(e.type);
    });
    const s = seedTulumGroup(world);

    expect(s.historyMessageIds.length).toBeGreaterThanOrEqual(5);
    expect(world.transcript(s.groupId, "nod")).toEqual([]);
    expect(world.groupService(s.groupId)).toBe("imessage");

    expect(world.addNod(s.groupId, s.users.sarah.id)).toEqual({ ok: true });
    await world.settled();
    expect(received).toEqual(["participant_added"]);
  });

  it("Brunch: a mixed iPhone/Android group that cannot add Nod", () => {
    const world = new ChatWorld();
    const s = seedMixedGroup(world);

    expect(world.groupService(s.groupId)).toBe("sms");
    expect(s.users.priya.platform).toBe("android");
    expect(world.addNod(s.groupId, s.users.will.id)).toEqual({ ok: false, reason: "not_all_imessage" });
  });
});
