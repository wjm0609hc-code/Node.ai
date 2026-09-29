// Is a message addressed to Nod? See CLAUDE.md, "Calling Nod".
//
// Two passes: `detectAddress` is a pure, synchronous check that sorts a
// message into certain / ambiguous / none. Only ambiguous messages ("he gave
// me the nod") go to the classifier, and Nod stays silent unless it answers
// a clear yes.
//
// Follow-up answers: when Nod asked this sender a question in this group and
// it's still open (see CLAUDE.md, "Follow-up answers"), a message that isn't
// already a call is checked with `classifyAnswer`, and counts only on a clear yes.

import type { InboundMessage, Phone } from "../messaging/types";

export type CertainReason = "private" | "mention" | "first_word" | "greeting" | "reply_to_nod";
export type NoneReason = "from_nod" | "tapback_text" | "no_name";
export type AmbiguousReason = "classifier_yes" | "classifier_no" | "classifier_error";
export type FollowupReason = "answer_to_nod" | "not_an_answer" | "answer_check_error";

export type FirstPass =
  | { tier: "certain"; reason: CertainReason }
  | { tier: "none"; reason: NoneReason }
  | { tier: "ambiguous" };

export type AddressedDecision =
  | { addressed: true; tier: "certain"; reason: CertainReason }
  | { addressed: false; tier: "none"; reason: NoneReason }
  | { addressed: boolean; tier: "ambiguous"; reason: AmbiguousReason }
  | { addressed: boolean; tier: "followup"; reason: FollowupReason };

export interface RecentMessage {
  from: string;
  text: string;
}

export type Classifier = (input: { text: string; recent: RecentMessage[] }) => Promise<boolean>;

/** Does `answer` answer the question Nod asked this person? */
export type AnswerClassifier = (input: { question: string; answer: string }) => Promise<boolean>;

export interface DetectContext {
  selfPhone: Phone;
  /** True when the message is an inline reply to one of Nod's own messages. */
  replyTargetIsNod?: boolean;
}

export interface AddressedContext extends DetectContext {
  classify: Classifier;
  /** Recent messages for the classifier; a function is only called for ambiguous messages. */
  recent?: RecentMessage[] | (() => Promise<RecentMessage[]>);
  /** The open question Nod asked this sender in this group, if any. */
  pendingQuestion?: string;
  classifyAnswer?: AnswerClassifier;
}

type DetectInput = Pick<InboundMessage, "from" | "groupId" | "text" | "mentions">;

// iOS/Android text fallbacks for tapbacks in SMS groups, e.g. `Liked “@Nod book it”`.
const TAPBACK_TEXT =
  /^(?:(?:Loved|Liked|Disliked|Laughed at|Emphasized|Questioned)|Removed an? [\w ]{1,30}? from|Reacted .{1,12}? to) [“"][\s\S]*[”"]$/u;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_WITH_SCHEME = /\b(?:https?:\/\/|www\.)\S+/gi;
const BARE_DOMAIN = /\b(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?/gi;

const MENTION = /(?:^|[^\w@])@nod(?!\w)/i;
const FIRST_WORD = /^[\s"'“‘(]*nod(?!\w)/i;
const GREETING = /\b(?:hey|hi|hiya|hello|yo|oi|ok|okay)\b[\s,]+@?nod(?!\w)/i;
const ANYWHERE = /\bnod\b/i;
// "Nod off" / "nod along" read as the verb even in a trigger position.
const VERB_FOLLOWS = /^\s+(?:off|along)\b/i;

function stripLinks(text: string): string {
  return text.replace(EMAIL, " ").replace(URL_WITH_SCHEME, " ").replace(BARE_DOMAIN, " ");
}

export function detectAddress(message: DetectInput, ctx: DetectContext): FirstPass {
  if (message.from === ctx.selfPhone) return { tier: "none", reason: "from_nod" };
  const text = message.text.trim();
  if (TAPBACK_TEXT.test(text)) return { tier: "none", reason: "tapback_text" };
  if (message.groupId === null) return { tier: "certain", reason: "private" };
  if (message.mentions.includes(ctx.selfPhone)) return { tier: "certain", reason: "mention" };
  if (ctx.replyTargetIsNod) return { tier: "certain", reason: "reply_to_nod" };

  const clean = stripLinks(text);
  if (MENTION.test(clean)) return { tier: "certain", reason: "mention" };

  const first = FIRST_WORD.exec(clean);
  if (first) {
    return VERB_FOLLOWS.test(clean.slice(first[0].length)) ? { tier: "ambiguous" } : { tier: "certain", reason: "first_word" };
  }
  const greeting = GREETING.exec(clean);
  if (greeting) {
    const rest = clean.slice(greeting.index + greeting[0].length);
    return VERB_FOLLOWS.test(rest) ? { tier: "ambiguous" } : { tier: "certain", reason: "greeting" };
  }
  if (ANYWHERE.test(clean)) return { tier: "ambiguous" };
  return { tier: "none", reason: "no_name" };
}

export async function isAddressedToNod(message: DetectInput, ctx: AddressedContext): Promise<AddressedDecision> {
  const first = detectAddress(message, ctx);
  if (first.tier === "certain") return { addressed: true, tier: "certain", reason: first.reason };
  if (first.tier === "none" && first.reason !== "no_name") return { addressed: false, tier: "none", reason: first.reason };

  let followup: FollowupReason | undefined;
  if (message.groupId !== null && ctx.pendingQuestion && ctx.classifyAnswer && message.text.trim()) {
    try {
      if (await ctx.classifyAnswer({ question: ctx.pendingQuestion, answer: message.text })) {
        return { addressed: true, tier: "followup", reason: "answer_to_nod" };
      }
      followup = "not_an_answer";
    } catch {
      followup = "answer_check_error";
    }
  }

  if (first.tier === "none") {
    return followup ? { addressed: false, tier: "followup", reason: followup } : { addressed: false, tier: "none", reason: first.reason };
  }
  try {
    const recent = typeof ctx.recent === "function" ? await ctx.recent() : (ctx.recent ?? []);
    const yes = await ctx.classify({ text: message.text, recent });
    return { addressed: yes, tier: "ambiguous", reason: yes ? "classifier_yes" : "classifier_no" };
  } catch {
    // When unsure, stay silent.
    return { addressed: false, tier: "ambiguous", reason: "classifier_error" };
  }
}
