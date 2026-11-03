// Wraps a MessagingProvider so nothing goes privately to someone who texted STOP, until
// they text START (handled in src/invites). Group messages still go out: the group
// hasn't opted out, and Nod only speaks there when someone calls it.

import type { Store } from "../db/store";
import type { Logger } from "../lib/log";
import type { CreateGroupRequest, CreateGroupResult, Destination, InboundHandler, MessagingProvider, OutboundContent, SendResult } from "./types";

export class StopGuardProvider implements MessagingProvider {
  readonly name: string;
  readonly selfPhone: string;

  constructor(
    private readonly inner: MessagingProvider,
    private readonly store: Store,
    private readonly logger?: Logger,
  ) {
    this.name = inner.name;
    this.selfPhone = inner.selfPhone;
  }

  onInbound(handler: InboundHandler): () => void {
    return this.inner.onInbound(handler);
  }

  async send(to: Destination, content: OutboundContent): Promise<SendResult> {
    if ("phone" in to) {
      const user = await this.store.upsertUser(to.phone);
      if (user.textsStoppedAt) {
        this.logger?.info("messaging.skipped_stopped", { userId: user.id });
        return { messageId: "", service: "imessage" }; // not sent, and so not recorded
      }
    }
    return this.inner.send(to, content);
  }

  createGroup(req: CreateGroupRequest): Promise<CreateGroupResult> {
    return this.inner.createGroup(req);
  }
}
