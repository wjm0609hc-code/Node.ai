// Sendblue inbound webhook → normalized InboundEvent.
//
// Field names come from Sendblue's official TypeScript SDK (sendblue 3.18.0,
// generated from their OpenAPI spec): content, is_outbound, status ("RECEIVED"
// for inbound), message_handle, from_number, to_number, media_url, service
// ("iMessage" | "SMS" | "RCS"), group_id, group_display_name, participants,
// reply_to.message_handle (inline replies), date_sent. Typing indicators
// ({ is_typing, ... }) can arrive on the same endpoint and are ignored.
//
// Not in the SDK, so still unverified: how tapbacks arrive (if as text such as
// `Loved “…”`, the tapback-text handling already counts them), real mentions,
// and an event for Nod being added to a group (joining is detected as the
// first message from a new group_id).

import type { InboundEvent, Phone } from "../types";

export function parseSendblueWebhook(body: unknown, selfPhone: Phone): InboundEvent | null {
  if (!body || typeof body !== "object") throw new Error("webhook body is not an object");
  const b = body as Record<string, unknown>;
  if (b.is_outbound === true) return null; // status callback for something Nod sent
  if ("is_typing" in b) return null; // typing indicator
  if (typeof b.status === "string" && b.status !== "RECEIVED") return null;

  const messageId = str(b.message_handle);
  if (!messageId) throw new Error("webhook payload missing message_handle");
  const from = str(b.from_number);
  if (!from) throw new Error("webhook payload missing from_number");
  if (from === selfPhone) return null;

  const sent = new Date(str(b.date_sent) ?? "");
  const media = str(b.media_url);
  const groupId = str(b.group_id) || null;
  const replyTo = b.reply_to && typeof b.reply_to === "object" ? str((b.reply_to as Record<string, unknown>).message_handle) : undefined;
  const participants = Array.isArray(b.participants)
    ? b.participants.filter((p): p is string => typeof p === "string" && E164.test(p) && p !== selfPhone)
    : [];
  const groupName = str(b.group_display_name)?.trim();
  return {
    type: "message",
    provider: "sendblue",
    messageId,
    groupId,
    from,
    text: str(b.content) ?? "",
    mediaUrls: media ? [media] : [],
    // Only iMessage has tapbacks, inline replies and mentions; SMS and RCS are treated alike.
    service: str(b.service)?.toLowerCase() === "imessage" || b.service === undefined ? "imessage" : "sms",
    mentions: [],
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
    ...(groupId && participants.length ? { participants } : {}),
    ...(groupId && groupName ? { groupName } : {}),
    sentAt: Number.isNaN(sent.getTime()) ? new Date() : sent,
  };
}

const E164 = /^\+[1-9]\d{6,14}$/;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
