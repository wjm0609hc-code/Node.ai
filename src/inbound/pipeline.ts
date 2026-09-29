// Inbound pipeline: provider event → store → isAddressedToNod → orchestrator.
// Architecture step from CLAUDE.md:
//   store message → isAddressedToNod()? if not, stop. → (step 4) build context, Claude, reply.

import type { MessageStore } from "../db/store";
import { detectAddress, isAddressedToNod, type AddressedDecision, type Classifier } from "../detection/addressed";
import type { InboundEvent, InboundMessage, Phone } from "../messaging/types";
import type { Logger } from "../lib/log";

export type { Logger } from "../lib/log";

export interface AddressedCall {
  event: InboundMessage;
  decision: AddressedDecision;
  /** Internal group id, or null for a private message. */
  groupId: string | null;
  senderUserId: string;
  firstSeenGroup: boolean;
}

export type InboundResult =
  | { status: "ignored"; why: "from_nod" }
  | { status: "duplicate" }
  | {
      status: "stored";
      addressed: boolean;
      reason: AddressedDecision["reason"];
      firstSeenGroup: boolean;
      handlerError?: boolean;
    }
  | { status: "reaction"; stored: boolean }
  | {
      status: "membership";
      firstSeenGroup: boolean;
      nodAdded: boolean;
      nodRemoved: boolean;
      addedByPhone?: Phone;
      removedByPhone?: Phone;
    };

export interface PipelineDeps {
  store: MessageStore;
  selfPhone: Phone;
  classify: Classifier;
  logger: Logger;
  /** Step 4 plugs Claude orchestration in here. */
  onAddressed?: (call: AddressedCall) => Promise<void>;
  /** How many recent messages the classifier sees. */
  classifierContext?: number;
  now?: () => Date;
}

export function createInboundPipeline(deps: PipelineDeps) {
  const { store, selfPhone, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function handle(event: InboundEvent): Promise<InboundResult> {
    switch (event.type) {
      case "message":
        return handleMessage(event);
      case "reaction": {
        if (event.from === selfPhone) return { status: "ignored", why: "from_nod" };
        const user = await store.upsertUser(event.from);
        const stored = await store.setReaction({
          provider: event.provider,
          targetProviderMessageId: event.targetMessageId,
          userId: user.id,
          reaction: event.reaction,
          removed: event.removed,
        });
        logger.info("inbound.reaction", { provider: event.provider, target: event.targetMessageId, stored });
        return { status: "reaction", stored };
      }
      case "participant_added": {
        const { group, created } = await store.upsertGroup({
          provider: event.provider,
          providerGroupId: event.groupId,
          name: event.groupName,
        });
        const members = await Promise.all(event.members.filter((p) => p !== selfPhone).map((p) => store.upsertUser(p)));
        await store.addMembers(group.id, members.map((m) => m.id));
        const nodAdded = event.added.includes(selfPhone);
        if (nodAdded) await store.setGroupJoined(group.id, event.sentAt);
        logger.info("inbound.participant_added", { provider: event.provider, groupId: group.id, nodAdded, created });
        return { status: "membership", firstSeenGroup: created, nodAdded, nodRemoved: false, addedByPhone: event.addedBy };
      }
      case "participant_removed": {
        const { group, created } = await store.upsertGroup({ provider: event.provider, providerGroupId: event.groupId });
        const nodRemoved = event.removed.includes(selfPhone);
        logger.info("inbound.participant_removed", { provider: event.provider, groupId: group.id, nodRemoved });
        return { status: "membership", firstSeenGroup: created, nodAdded: false, nodRemoved, removedByPhone: event.removedBy };
      }
    }
  }

  async function handleMessage(event: InboundMessage): Promise<InboundResult> {
    if (event.from === selfPhone) return { status: "ignored", why: "from_nod" };
    if (await store.hasMessage(event.provider, event.messageId)) return { status: "duplicate" };

    const sender = await store.upsertUser(event.from);
    let groupId: string | null = null;
    let firstSeenGroup = false;
    let optedOut = false;
    if (event.groupId) {
      const { group, created } = await store.upsertGroup({ provider: event.provider, providerGroupId: event.groupId });
      groupId = group.id;
      firstSeenGroup = created;
      await store.addMembers(group.id, [sender.id]);
      optedOut = await store.isOptedOut(group.id, sender.id);
    }

    // Save first: the unique provider message id is the claim that makes retries safe.
    const saved = await store.saveMessage({
      provider: event.provider,
      providerMessageId: event.messageId,
      groupId,
      dmUserId: groupId ? null : sender.id,
      senderUserId: sender.id,
      fromNod: false,
      text: optedOut ? null : event.text,
      mediaUrls: optedOut ? [] : event.mediaUrls,
      service: event.service,
      replyToProviderMessageId: event.replyToMessageId ?? null,
      addressed: false,
      createdAt: event.sentAt ?? now(),
    });
    if (saved.duplicate) return { status: "duplicate" };

    const replyTargetIsNod = event.replyToMessageId ? await store.isFromNod(event.provider, event.replyToMessageId) : false;
    const scope = groupId ? { groupId } : { dmUserId: sender.id };
    const decision = await isAddressedToNod(event, {
      selfPhone,
      replyTargetIsNod,
      classify: deps.classify,
      // Names only: phone numbers never leave for the classifier.
      recent: async () =>
        (await store.recentMessages(scope, deps.classifierContext ?? 5, { excludeId: saved.id })).map((m) => ({
          ...m,
          from: m.from.startsWith("+") ? "A member" : m.from,
        })),
    });

    if (decision.addressed) {
      await store.setAddressed(saved.id!, true);
      // An opted-out member calling Nod still gets an answer, so keep that message.
      if (optedOut) await store.setMessageText(saved.id!, event.text);
    }
    logger.info("inbound.message", {
      provider: event.provider,
      messageId: event.messageId,
      groupId,
      service: event.service,
      addressed: decision.addressed,
      reason: decision.reason,
      firstSeenGroup,
      optedOut,
    });

    const result: InboundResult = { status: "stored", addressed: decision.addressed, reason: decision.reason, firstSeenGroup };
    if (decision.addressed && deps.onAddressed) {
      try {
        await deps.onAddressed({ event, decision, groupId, senderUserId: sender.id, firstSeenGroup });
      } catch (err) {
        logger.error("inbound.on_addressed_failed", { messageId: event.messageId, error: (err as Error).name });
        result.handlerError = true;
      }
    }
    return result;
  }

  return { handle, detect: detectAddress };
}

export type InboundPipeline = ReturnType<typeof createInboundPipeline>;
