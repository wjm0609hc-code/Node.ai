import { describe, expect, it, vi } from "vitest";
import type { InboundEvent } from "../types";
import { SendblueProvider } from "./provider";

const NOD = "+15550100000";

function make(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  const provider = new SendblueProvider({
    apiKeyId: "kid",
    apiSecretKey: "secret",
    fromNumber: NOD,
    contactCardUrl: (card) => `https://nod.test/cards/${encodeURIComponent(card.phone)}.vcf`,
    fetch,
    sleep: async () => {},
  });
  return { provider, calls, fetch };
}

describe("SendblueProvider", () => {
  it("sends a private message with auth headers", async () => {
    const { provider, calls } = make([{ status: 200, body: { message_handle: "mh1", status: "QUEUED" } }]);
    const res = await provider.send({ phone: "+15550100001" }, { text: "hi" });

    expect(res.messageId).toBe("mh1");
    expect(calls[0]!.url).toBe("https://api.sendblue.co/api/send-message");
    expect(calls[0]!.headers).toMatchObject({ "sb-api-key-id": "kid", "sb-api-secret-key": "secret" });
    expect(calls[0]!.body).toEqual({ number: "+15550100001", from_number: NOD, content: "hi" });
  });

  it("sends to an existing group by group_id", async () => {
    const { provider, calls } = make([{ status: 200, body: { message_handle: "mh2", group_id: "g1" } }]);
    await provider.send({ groupId: "g1" }, { text: "Will added me." });

    expect(calls[0]!.url).toBe("https://api.sendblue.co/api/send-group-message");
    expect(calls[0]!.body).toEqual({ group_id: "g1", from_number: NOD, content: "Will added me." });
  });

  it("sends a contact card as a hosted .vcf with the text, one media per call", async () => {
    const { provider, calls } = make([
      { status: 200, body: { message_handle: "a" } },
      { status: 200, body: { message_handle: "b" } },
    ]);
    const res = await provider.send(
      { groupId: "g1" },
      { text: "Tag @Nod when you need me.", mediaUrls: ["https://nod.test/howto.mp4"], contactCard: { name: "Nod", phone: NOD } },
    );

    expect(res.messageId).toBe("a");
    expect(calls.map((c) => c.body)).toEqual([
      { group_id: "g1", from_number: NOD, content: "Tag @Nod when you need me.", media_url: "https://nod.test/howto.mp4" },
      { group_id: "g1", from_number: NOD, media_url: "https://nod.test/cards/%2B15550100000.vcf" },
    ]);
  });

  it("maps the reported service", async () => {
    const { provider } = make([{ status: 200, body: { message_handle: "m", service: "SMS" } }]);
    expect((await provider.send({ phone: "+15550100002" }, { text: "x" })).service).toBe("sms");
  });

  it("creates a group from numbers and returns its group_id", async () => {
    const { provider, calls } = make([{ status: 200, body: { message_handle: "m", group_id: "new-g" } }]);
    const res = await provider.createGroup({
      members: ["+15550100001", "+15550100002"],
      name: "Tulum",
      firstMessage: { text: "Will asked me to start this group." },
    });

    expect(res.groupId).toBe("new-g");
    expect(calls[0]!.body).toEqual({
      numbers: ["+15550100001", "+15550100002"],
      from_number: NOD,
      content: "Will asked me to start this group.",
    });
  });

  it("names a new iMessage group and sets its photo, best-effort", async () => {
    const warnings: unknown[] = [];
    const { provider, calls } = make([
      { status: 200, body: { message_handle: "m", group_id: "sb_group_1", service: "iMessage" } },
      { status: 200, body: { status: "OK", data: { group_name: "Tulum" } } },
      { status: 400, body: { error: "unsupported_line" } },
    ]);
    (provider as any).config.onWarning = (_e: string, f: unknown) => warnings.push(f);
    const res = await provider.createGroup({ members: ["+15550100001", "+15550100002"], name: "Tulum", photoUrl: "https://nod.test/nod-logo.png", firstMessage: { text: "x" } });
    expect(res).toEqual({ groupId: "sb_group_1", service: "imessage" });
    expect(calls[1]).toMatchObject({ url: "https://api.sendblue.co/api/v2/groups/sb_group_1/name", body: { group_name: "Tulum", from_number: NOD } });
    expect(calls[2]).toMatchObject({ url: "https://api.sendblue.co/api/v2/groups/sb_group_1/photo", body: { photo_url: "https://nod.test/nod-logo.png", from_number: NOD } });
    expect(warnings).toEqual([expect.objectContaining({ what: "group_photo" })]);
  });

  it("doesn't try to name SMS groups", async () => {
    const { provider, calls } = make([{ status: 200, body: { message_handle: "m", group_id: "g", service: "SMS" } }]);
    await provider.createGroup({ members: ["+15550100001", "+15550100002"], name: "Tulum", firstMessage: { text: "x" } });
    expect(calls).toHaveLength(1);
  });

  it("sends inline replies with reply_to", async () => {
    const { provider, calls } = make([{ status: 200, body: { message_handle: "m" } }]);
    await provider.send({ groupId: "g1" }, { text: "Booked.", replyToMessageId: "mh-9" });
    expect(calls[0]!.body).toEqual({ group_id: "g1", from_number: NOD, content: "Booked.", reply_to: { message_handle: "mh-9" } });
  });

  it("fails createGroup when no group_id comes back", async () => {
    const { provider } = make([{ status: 200, body: { message_handle: "m" } }]);
    await expect(
      provider.createGroup({ members: ["+15550100001", "+15550100002"], firstMessage: { text: "x" } }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("rejects empty content without calling the API", async () => {
    const { provider, fetch } = make([]);
    await expect(provider.send({ phone: "+15550100001" }, {})).rejects.toMatchObject({ code: "empty_message" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("wraps API errors as MessagingError and retries rate limits", async () => {
    const { provider, fetch } = make([
      { status: 429, body: {} },
      { status: 200, body: { message_handle: "ok" } },
    ]);
    await expect(provider.send({ phone: "+15550100001" }, { text: "x" })).resolves.toMatchObject({ messageId: "ok" });
    expect(fetch).toHaveBeenCalledTimes(2);

    const bad = make([{ status: 400, body: { error: "invalid number" } }]);
    await expect(bad.provider.send({ phone: "nope" }, { text: "x" })).rejects.toMatchObject({ code: "provider_error" });
  });

  it("hands webhook events to registered handlers", async () => {
    const { provider } = make([]);
    const seen: string[] = [];
    const off = provider.onInbound((e) => {
      seen.push(e.type);
    });
    const event: InboundEvent = { type: "participant_removed", provider: "sendblue", groupId: "g1", removedBy: "+1", removed: [NOD], sentAt: new Date() };
    await provider.dispatch(event);
    off();
    await provider.dispatch(event);
    expect(seen).toEqual(["participant_removed"]);
  });
});
