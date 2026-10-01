// Replies as durable jobs: the webhook stores the message and queues the call; the
// `reply` Inngest function answers it with retries. The responder saves its progress
// (see `replies` in the schema), so a retry resumes instead of repeating tool calls.

import type { AddressedCall } from "../inbound/pipeline";

export const REPLY_EVENT = "nod/reply.requested";
/** Attempts in total (the first try plus retries). */
export const REPLY_ATTEMPTS = 4 as const;

export interface ReplyEventData {
  /** One chat's replies run one at a time, in order. */
  chatKey: string;
  call: Record<string, unknown>;
}

export function replyEvent(call: AddressedCall): { name: string; data: ReplyEventData } {
  const chatKey = call.groupId ? `g:${call.groupId}` : `u:${call.senderUserId}`;
  return { name: REPLY_EVENT, data: { chatKey, call: JSON.parse(JSON.stringify(call)) } };
}

/** The call back from JSON (dates revived). */
export function reviveCall(data: ReplyEventData): AddressedCall {
  const call = structuredClone(data.call) as unknown as AddressedCall & { event: { sentAt: string | Date } };
  call.event.sentAt = new Date(call.event.sentAt);
  return call;
}

/** The body of the Inngest function, kept here so it can be tested without Inngest. */
export async function runReplyJob(
  data: ReplyEventData,
  attempt: { attempt: number; maxAttempts?: number },
  handleAddressed: (call: AddressedCall, opts: { final: boolean }) => Promise<void>,
): Promise<void> {
  const final = attempt.attempt + 1 >= (attempt.maxAttempts ?? REPLY_ATTEMPTS);
  await handleAddressed(reviveCall(data), { final });
}
