import {
  MessagingError,
  type CreateGroupRequest,
  type CreateGroupResult,
  type Destination,
  type InboundEvent,
  type InboundHandler,
  type MessagingProvider,
  type OutboundContent,
  type SendResult,
} from "../types";
import type { ChatWorld } from "./world";
import { NOD_PHONE } from "./world";

/** Nod's view of a ChatWorld. Behaves like a real provider: events in, sends out. */
export class SimulatorProvider implements MessagingProvider {
  readonly name = "simulator";
  readonly selfPhone = NOD_PHONE;
  private handlers = new Set<InboundHandler>();

  constructor(private readonly world: ChatWorld) {}

  onInbound(handler: InboundHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private tail: Promise<void> = Promise.resolve();

  /** @internal Called by ChatWorld; stands in for the webhook. Events are handled one at a time, in order. */
  dispatch(event: InboundEvent): Promise<void> {
    const run = this.tail.then(async () => {
      for (const h of [...this.handlers]) await h(event);
    });
    this.tail = run.catch(() => {});
    return run;
  }

  async send(to: Destination, content: OutboundContent): Promise<SendResult> {
    const body = normalize(content);
    if ("groupId" in to) {
      const line = this.world.nodSendToGroup(to.groupId, { ...body, replyToMessageId: content.replyToMessageId });
      return { messageId: line.messageId, service: this.world.groupService(to.groupId) };
    }
    const line = this.world.nodSendToPhone(to.phone, body);
    const user = this.world.userByPhone(to.phone)!;
    return { messageId: line.messageId, service: user.platform === "iphone" ? "imessage" : "sms" };
  }

  async createGroup(req: CreateGroupRequest): Promise<CreateGroupResult> {
    const body = normalize(req.firstMessage);
    const groupId = this.world.nodCreateGroup(req.members, req.name);
    this.world.nodSendToGroup(groupId, body);
    return { groupId, service: this.world.groupService(groupId) };
  }
}

function normalize(content: OutboundContent) {
  const text = content.text ?? "";
  const mediaUrls = content.mediaUrls ?? [];
  if (!text && !mediaUrls.length && !content.contactCard) {
    throw new MessagingError("message has no text, media, or contact card", "empty_message");
  }
  return { text, mediaUrls, contactCard: content.contactCard };
}
