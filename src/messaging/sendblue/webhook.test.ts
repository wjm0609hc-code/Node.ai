import { describe, expect, it } from "vitest";
import { parseSendblueWebhook } from "./webhook";

const NOD = "+15550100000";

const base = {
  accountEmail: "ops@example.com",
  content: "@Nod compare these",
  is_outbound: false,
  status: "RECEIVED",
  message_handle: "mh-123",
  date_sent: "2026-09-29T15:00:00.000Z",
  date_updated: "2026-09-29T15:00:00.000Z",
  from_number: "+15550200001",
  number: "+15550200001",
  to_number: NOD,
  sendblue_number: NOD,
  media_url: "",
  service: "iMessage",
  group_id: "",
};

describe("parseSendblueWebhook", () => {
  it("parses a private message", () => {
    expect(parseSendblueWebhook(base, NOD)).toEqual({
      type: "message",
      provider: "sendblue",
      messageId: "mh-123",
      groupId: null,
      from: "+15550200001",
      text: "@Nod compare these",
      mediaUrls: [],
      service: "imessage",
      mentions: [],
      sentAt: new Date("2026-09-29T15:00:00.000Z"),
    });
  });

  it("parses a group message", () => {
    const e = parseSendblueWebhook({ ...base, group_id: "grp-1", participants: ["+15550200001", "+15550200002", NOD] }, NOD);
    expect(e).toMatchObject({ type: "message", groupId: "grp-1", participants: ["+15550200001", "+15550200002"] });
  });

  it("keeps the group's name and only phone-number participants", () => {
    const e = parseSendblueWebhook({ ...base, group_id: "grp-1", group_display_name: "Tulum 🌴", participants: ["+15550200001", "sam@icloud.com", NOD] }, NOD);
    expect(e).toMatchObject({ groupName: "Tulum 🌴", participants: ["+15550200001"] });
    expect(parseSendblueWebhook({ ...base, group_id: "grp-1", group_display_name: null }, NOD)).not.toHaveProperty("groupName");
  });

  it("reads inline replies from reply_to", () => {
    expect(parseSendblueWebhook({ ...base, reply_to: { message_handle: "mh-nod-1", part_index: 0 } }, NOD)).toMatchObject({ replyToMessageId: "mh-nod-1" });
    expect(parseSendblueWebhook({ ...base, reply_to: {} }, NOD)).not.toHaveProperty("replyToMessageId");
  });

  it("treats RCS like SMS (no tapbacks, inline replies or mentions)", () => {
    expect(parseSendblueWebhook({ ...base, service: "RCS" }, NOD)).toMatchObject({ service: "sms" });
  });

  it("ignores typing indicators and non-received statuses", () => {
    expect(parseSendblueWebhook({ number: "+15550200001", is_typing: true, from_number: "+15550200001", timestamp: "2026-09-29T15:00:00Z" }, NOD)).toBeNull();
    expect(parseSendblueWebhook({ ...base, status: "DELIVERED" }, NOD)).toBeNull();
    expect(parseSendblueWebhook({ ...base, status: undefined }, NOD)).not.toBeNull();
  });

  it("maps SMS and media", () => {
    const e = parseSendblueWebhook({ ...base, service: "SMS", media_url: "https://cdn.example/x.jpg", content: "" }, NOD);
    expect(e).toMatchObject({ service: "sms", mediaUrls: ["https://cdn.example/x.jpg"], text: "" });
  });

  it("ignores outbound status callbacks and Nod's own messages", () => {
    expect(parseSendblueWebhook({ ...base, is_outbound: true }, NOD)).toBeNull();
    expect(parseSendblueWebhook({ ...base, from_number: NOD }, NOD)).toBeNull();
  });

  it("rejects payloads without a message id or sender", () => {
    expect(() => parseSendblueWebhook({ ...base, message_handle: undefined }, NOD)).toThrow(/message_handle/);
    expect(() => parseSendblueWebhook({ ...base, from_number: "" }, NOD)).toThrow(/from_number/);
    expect(() => parseSendblueWebhook("nope", NOD)).toThrow();
  });

  it("falls back to now when the date is missing or bad", () => {
    const e = parseSendblueWebhook({ ...base, date_sent: "garbage" }, NOD);
    expect(e && "sentAt" in e && e.sentAt instanceof Date && !Number.isNaN(e.sentAt.getTime())).toBe(true);
  });
});
