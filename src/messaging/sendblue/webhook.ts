// Sendblue inbound webhook → normalized InboundEvent.
//
// Field names follow Sendblue's receive-message webhook as we understand it:
// content, is_outbound, message_handle, from_number, to_number, media_url,
// service ("iMessage" | "SMS"), group_id, participants, date_sent.
// TODO(verify against docs.sendblue.com): reactions, inline replies,
// mentions and group-membership events. Until then, joining a group is
// detected as the first message from a new group_id.

import type { InboundEvent, Phone } from "../types";

export function parseSendblueWebhook(body: unknown, selfPhone: Phone): InboundEvent | null {
  if (!body || typeof body !== "object") throw new Error("webhook body is not an object");
  const b = body as Record<string, unknown>;
  if (b.is_outbound === true) return null; // status callback for something Nod sent

  const messageId = str(b.message_handle);
  if (!messageId) throw new Error("webhook payload missing message_handle");
  const from = str(b.from_number);
  if (!from) throw new Error("webhook payload missing from_number");
  if (from === selfPhone) return null;

  const sent = new Date(str(b.date_sent) ?? "");
  const media = str(b.media_url);
  return {
    type: "message",
    provider: "sendblue",
    messageId,
    groupId: str(b.group_id) || null,
    from,
    text: str(b.content) ?? "",
    mediaUrls: media ? [media] : [],
    service: str(b.service)?.toLowerCase() === "sms" ? "sms" : "imessage",
    mentions: [],
    sentAt: Number.isNaN(sent.getTime()) ? new Date() : sent,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
