// Wraps a MessagingProvider so everything Nod sends is stored. Replies to
// Nod's messages are a certain trigger, so we must know which ones are Nod's.

import type { Store } from "../db/store";
import type {
  CreateGroupRequest,
  CreateGroupResult,
  Destination,
  InboundHandler,
  MessagingProvider,
  OutboundContent,
  SendResult,
} from "../messaging/types";

export class RecordingProvider implements MessagingProvider {
  readonly name: string;
  readonly selfPhone: string;

  constructor(
    private readonly inner: MessagingProvider,
    private readonly store: Store,
  ) {
    this.name = inner.name;
    this.selfPhone = inner.selfPhone;
  }

  onInbound(handler: InboundHandler): () => void {
    return this.inner.onInbound(handler);
  }

  async send(to: Destination, content: OutboundContent): Promise<SendResult> {
    const result = await this.inner.send(to, content);
    await this.record(to, result, content);
    return result;
  }

  async createGroup(req: CreateGroupRequest): Promise<CreateGroupResult> {
    const result = await this.inner.createGroup(req);
    const { group } = await this.store.upsertGroup({ provider: this.name, providerGroupId: result.groupId, name: req.name });
    const members = await Promise.all(req.members.map((p) => this.store.upsertUser(p)));
    await this.store.addMembers(group.id, members.map((m) => m.id));
    return result;
  }

  private async record(to: Destination, result: SendResult, content: OutboundContent) {
    if (!result.messageId) return;
    let groupId: string | null = null;
    let dmUserId: string | null = null;
    if ("groupId" in to) groupId = (await this.store.upsertGroup({ provider: this.name, providerGroupId: to.groupId })).group.id;
    else dmUserId = (await this.store.upsertUser(to.phone)).id;
    await this.store.saveMessage({
      provider: this.name,
      providerMessageId: result.messageId,
      groupId,
      dmUserId,
      senderUserId: null,
      fromNod: true,
      text: content.text ?? "",
      mediaUrls: content.mediaUrls ?? [],
      service: result.service,
      replyToProviderMessageId: content.replyToMessageId ?? null,
      addressed: false,
      createdAt: new Date(),
    });
  }
}
