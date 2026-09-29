// Provider-neutral messaging types. Business logic only ever sees these,
// so Sendblue, the local simulator, and (later) WhatsApp are interchangeable.

/** E.164 phone number, e.g. "+15550100001". */
export type Phone = string;

/** Transport a message travelled over. iMessage supports tapbacks and inline replies; SMS/MMS does not. */
export type Service = "imessage" | "sms";

export type Tapback = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

export interface InboundMessage {
  type: "message";
  provider: string;
  messageId: string;
  /** null for a private (1:1) message to Nod. */
  groupId: string | null;
  from: Phone;
  text: string;
  mediaUrls: string[];
  service: Service;
  /** Set when this is an inline reply to another message. */
  replyToMessageId?: string;
  /** Phones mentioned with a real iMessage mention (not just typed text). */
  mentions: Phone[];
  /** Contact cards the sender shared (vCards), already parsed. */
  contactCards?: ContactCard[];
  sentAt: Date;
}

export interface InboundReaction {
  type: "reaction";
  provider: string;
  groupId: string | null;
  from: Phone;
  targetMessageId: string;
  reaction: Tapback;
  /** True when the sender removed a previous tapback. */
  removed: boolean;
  sentAt: Date;
}

export interface InboundParticipantAdded {
  type: "participant_added";
  provider: string;
  groupId: string;
  /** Who performed the add. */
  addedBy: Phone;
  added: Phone[];
  /** Everyone in the group after the change, including Nod. */
  members: Phone[];
  groupName?: string;
  service: Service;
  sentAt: Date;
}

export interface InboundParticipantRemoved {
  type: "participant_removed";
  provider: string;
  groupId: string;
  removedBy: Phone;
  removed: Phone[];
  sentAt: Date;
}

export type InboundEvent =
  | InboundMessage
  | InboundReaction
  | InboundParticipantAdded
  | InboundParticipantRemoved;

export interface ContactCard {
  name: string;
  phone: Phone;
  photoUrl?: string;
}

export interface OutboundContent {
  text?: string;
  mediaUrls?: string[];
  contactCard?: ContactCard;
  /** Inline reply target, where the transport supports it. */
  replyToMessageId?: string;
}

export type Destination = { groupId: string } | { phone: Phone };

export interface SendResult {
  messageId: string;
  service: Service;
}

export interface CreateGroupRequest {
  members: Phone[];
  name?: string;
  photoUrl?: string;
  /** Sent as the first message in the new group. */
  firstMessage: OutboundContent;
}

export interface CreateGroupResult {
  groupId: string;
  service: Service;
}

export type InboundHandler = (event: InboundEvent) => void | Promise<void>;

export interface MessagingProvider {
  readonly name: string;
  /** Nod's own number on this provider. */
  readonly selfPhone: Phone;
  send(to: Destination, content: OutboundContent): Promise<SendResult>;
  /** Fallback path: Nod starts a group itself (works for small or mixed iPhone/Android groups). */
  createGroup(req: CreateGroupRequest): Promise<CreateGroupResult>;
  /** Register the handler for inbound events. Returns an unsubscribe function. */
  onInbound(handler: InboundHandler): () => void;
}

export class MessagingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}
