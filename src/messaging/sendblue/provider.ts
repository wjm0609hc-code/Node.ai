// Sendblue (iMessage) implementation of MessagingProvider: outbound sends here;
// inbound webhooks are parsed in ./webhook.ts and passed to `dispatch()`.
//
// Confirmed from Sendblue's official SDK (sendblue 3.18.0): POST /api/send-message
// and /api/send-group-message, `sb-api-key-id` / `sb-api-secret-key` headers,
// `numbers` (new group, up to 25) or `group_id` (existing group), `content`,
// `media_url` (one per message), `reply_to: { message_handle }` for inline
// replies, `message_handle` in responses, and POST /api/v2/groups/{id}/name and
// /photo to name a group and set its photo.
// Still unverified: native contact-card sending (we send a hosted .vcf as media).

import { HttpError, requestJson, type RequestOptions } from "../../lib/http";
import {
  MessagingError,
  type ContactCard,
  type CreateGroupRequest,
  type CreateGroupResult,
  type Destination,
  type InboundEvent,
  type InboundHandler,
  type MessagingProvider,
  type OutboundContent,
  type Phone,
  type SendResult,
  type Service,
} from "../types";

export interface SendblueConfig {
  apiKeyId: string;
  apiSecretKey: string;
  fromNumber: Phone;
  /** Hosted .vcf URL for a contact card (served by our web app). */
  contactCardUrl: (card: ContactCard) => string;
  baseUrl?: string;
  fetch?: RequestOptions["fetch"];
  sleep?: RequestOptions["sleep"];
  /** Told about best-effort steps that failed (naming a new group, setting its photo). */
  onWarning?: (event: string, fields: Record<string, unknown>) => void;
}

interface SendblueResponse {
  message_handle?: string;
  group_id?: string;
  service?: string;
}

export class SendblueProvider implements MessagingProvider {
  readonly name = "sendblue";
  readonly selfPhone: Phone;
  private handlers = new Set<InboundHandler>();

  constructor(private readonly config: SendblueConfig) {
    this.selfPhone = config.fromNumber;
  }

  static fromEnv(env: NodeJS.ProcessEnv, contactCardUrl: SendblueConfig["contactCardUrl"], onWarning?: SendblueConfig["onWarning"]): SendblueProvider {
    const need = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`missing env ${k}`);
      return v;
    };
    return new SendblueProvider({
      apiKeyId: need("SENDBLUE_API_KEY_ID"),
      apiSecretKey: need("SENDBLUE_API_SECRET_KEY"),
      fromNumber: need("SENDBLUE_FROM_NUMBER"),
      contactCardUrl,
      onWarning,
    });
  }

  onInbound(handler: InboundHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Called by the webhook route with a normalized event. */
  async dispatch(event: InboundEvent): Promise<void> {
    for (const h of [...this.handlers]) await h(event);
  }

  async send(to: Destination, content: OutboundContent): Promise<SendResult> {
    const target = "groupId" in to ? { group_id: to.groupId } : { number: to.phone };
    const path = "groupId" in to ? "/api/send-group-message" : "/api/send-message";
    const [first] = await this.sendParts(path, target, content);
    return { messageId: first!.message_handle ?? "", service: mapService(first!.service) };
  }

  async createGroup(req: CreateGroupRequest): Promise<CreateGroupResult> {
    const [first] = await this.sendParts("/api/send-group-message", { numbers: req.members }, req.firstMessage);
    if (!first?.group_id) throw new MessagingError("Sendblue did not return a group_id", "provider_error");
    const service = mapService(first.service);
    // Name and photo are best-effort: SMS groups and some lines can't take them, and the group already works.
    if (service === "imessage") {
      const id = encodeURIComponent(first.group_id);
      if (req.name) await this.tryPost(`/api/v2/groups/${id}/name`, { group_name: req.name, from_number: this.config.fromNumber }, "group_name");
      if (req.photoUrl) await this.tryPost(`/api/v2/groups/${id}/photo`, { photo_url: req.photoUrl, from_number: this.config.fromNumber }, "group_photo");
    }
    return { groupId: first.group_id, service };
  }

  private async tryPost(path: string, body: Record<string, unknown>, what: string): Promise<void> {
    try {
      await this.post(path, body);
    } catch (err) {
      this.config.onWarning?.("sendblue.best_effort_failed", { what, error: (err as Error).message });
    }
  }

  /** Text rides with the first media item; each further media item is its own message. */
  private async sendParts(path: string, target: Record<string, unknown>, content: OutboundContent) {
    const media = [...(content.mediaUrls ?? [])];
    if (content.contactCard) media.push(this.config.contactCardUrl(content.contactCard));
    if (!content.text && !media.length) throw new MessagingError("message has no text, media, or contact card", "empty_message");

    const bodies: Record<string, unknown>[] = [];
    const firstBody: Record<string, unknown> = { ...target, from_number: this.config.fromNumber };
    if (content.text) firstBody.content = content.text;
    if (content.replyToMessageId) firstBody.reply_to = { message_handle: content.replyToMessageId };
    if (media[0]) firstBody.media_url = media[0];
    bodies.push(firstBody);
    for (const url of media.slice(1)) bodies.push({ ...target, from_number: this.config.fromNumber, media_url: url });

    const results: SendblueResponse[] = [];
    for (const body of bodies) results.push(await this.post(path, body));
    return results;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<SendblueResponse> {
    try {
      return await requestJson<SendblueResponse>(
        `${this.config.baseUrl ?? "https://api.sendblue.co"}${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "sb-api-key-id": this.config.apiKeyId,
            "sb-api-secret-key": this.config.apiSecretKey,
          },
          body: JSON.stringify(body),
        },
        // A timed-out send may still have been delivered; don't send it twice.
        { retryOnTimeout: false, fetch: this.config.fetch, sleep: this.config.sleep },
      );
    } catch (err) {
      if (err instanceof HttpError) throw new MessagingError(err.message, "provider_error");
      throw err;
    }
  }
}

function mapService(s: string | undefined): Service {
  return s?.toLowerCase().includes("sms") ? "sms" : "imessage";
}
