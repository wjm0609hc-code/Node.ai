// Inbound pipeline: provider event → store → isAddressedToNod → orchestrator.
// Architecture step from CLAUDE.md:
//   store message → isAddressedToNod()? if not, stop. → (step 4) build context, Claude, reply.

import type { Store } from "../db/store";
import { detectAddress, isAddressedToNod, type AddressedDecision, type Classifier } from "../detection/addressed";
import type { InboundEvent, InboundMessage, Phone, Service } from "../messaging/types";
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

/** A stored message Nod may read (from a member who hasn't opted out, or a private message). */
export interface MessageCall {
  event: InboundMessage;
  groupId: string | null;
  senderUserId: string;
  optedOut: boolean;
}

/** Nod is now in a group: added by someone, or first heard from it through a message. */
export interface JoinCall {
  groupId: string;
  provider: string;
  providerGroupId: string;
  via: "join_event" | "first_message";
  /** Known only for join events. */
  addedByUserId: string | null;
  service: Service;
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
      /** The call was handed to `defer` to run after the webhook responds. */
      deferred?: boolean;
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
  store: Store;
  selfPhone: Phone;
  classify: Classifier;
  logger: Logger;
  /** Step 4 plugs Claude orchestration in here. */
  onAddressed?: (call: AddressedCall) => Promise<void>;
  /** Introduction, access notes (onboarding). Runs before any call in the same message is handled. */
  onJoined?: (call: JoinCall) => Promise<void>;
  onLeft?: (call: { groupId: string }) => Promise<void>;
  /** Every stored, readable message, before call handling (e.g. remembering rental links). Nod stays silent here. */
  onMessage?: (call: MessageCall) => Promise<void>;
  /** How many recent messages the classifier sees. */
  classifierContext?: number;
  now?: () => Date;
}

export interface HandleOptions {
  /** Schedules work to run after the webhook has responded (Next.js `after`). */
  defer?: (task: () => Promise<void>) => void;
}

export function createInboundPipeline(deps: PipelineDeps) {
  const { store, selfPhone, logger } = deps;
  const now = deps.now ?? (() => new Date());

  // Hooks never make the webhook fail: a retry would be deduped and skip them anyway.
  async function runHook(name: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      logger.error(`inbound.${name}_failed`, { error: (err as Error).name, code: (err as { code?: string }).code });
      return false;
    }
  }

  async function handle(event: InboundEvent, opts: HandleOptions = {}): Promise<InboundResult> {
    switch (event.type) {
      case "message":
        return handleMessage(event, opts);
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
        const adder = await store.upsertUser(event.addedBy);
        await store.addMembers(group.id, [...members.map((m) => m.id), adder.id]);
        const nodAdded = event.added.includes(selfPhone);
        logger.info("inbound.participant_added", { provider: event.provider, groupId: group.id, nodAdded, created });
        if (nodAdded) {
          await store.setGroupJoined(group.id, event.sentAt);
          await store.setAddedBy(group.id, adder.id);
          if (deps.onJoined) {
            const onJoined = deps.onJoined;
            await runHook("on_joined", () =>
              onJoined({
                groupId: group.id,
                provider: event.provider,
                providerGroupId: event.groupId,
                via: "join_event",
                addedByUserId: adder.id,
                service: event.service,
              }),
            );
          }
        }
        return { status: "membership", firstSeenGroup: created, nodAdded, nodRemoved: false, addedByPhone: event.addedBy };
      }
      case "participant_removed": {
        const { group, created } = await store.upsertGroup({ provider: event.provider, providerGroupId: event.groupId });
        const nodRemoved = event.removed.includes(selfPhone);
        logger.info("inbound.participant_removed", { provider: event.provider, groupId: group.id, nodRemoved });
        if (nodRemoved && deps.onLeft) {
          const onLeft = deps.onLeft;
          await runHook("on_left", () => onLeft({ groupId: group.id }));
        }
        return { status: "membership", firstSeenGroup: created, nodAdded: false, nodRemoved, removedByPhone: event.removedBy };
      }
    }
  }

  async function handleMessage(event: InboundMessage, opts: HandleOptions): Promise<InboundResult> {
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

    if (firstSeenGroup && groupId && deps.onJoined) {
      const onJoined = deps.onJoined;
      const gid = groupId;
      await runHook("on_joined", () =>
        onJoined({
          groupId: gid,
          provider: event.provider,
          providerGroupId: event.groupId!,
          via: "first_message",
          addedByUserId: null,
          service: event.service,
        }),
      );
    }

    if (!optedOut && deps.onMessage) {
      const onMessage = deps.onMessage;
      await runHook("on_message", () => onMessage({ event, groupId, senderUserId: sender.id, optedOut }));
    }

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
      const onAddressed = deps.onAddressed;
      const task = () => onAddressed({ event, decision, groupId, senderUserId: sender.id, firstSeenGroup });
      if (opts.defer) {
        // Answering can take a while (Claude, tools); store now, reply after the webhook returns.
        opts.defer(async () => {
          await runHook("on_addressed", task);
        });
        result.deferred = true;
      } else if (!(await runHook("on_addressed", task))) {
        result.handlerError = true;
      }
    }
    return result;
  }

  return { handle, detect: detectAddress };
}

export type InboundPipeline = ReturnType<typeof createInboundPipeline>;
