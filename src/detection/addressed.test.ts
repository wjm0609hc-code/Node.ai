import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../messaging/types";
import { detectAddress, isAddressedToNod, type Classifier } from "./addressed";

const NOD = "+15550100000";
const WILL = "+15550200001";

function msg(text: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    type: "message",
    provider: "test",
    messageId: "m1",
    groupId: "g1",
    from: WILL,
    text,
    mediaUrls: [],
    service: "imessage",
    mentions: [],
    sentAt: new Date(),
    ...over,
  };
}

const never: Classifier = async () => {
  throw new Error("classifier should not be called");
};

async function check(text: string, over: Partial<InboundMessage> = {}, extra: { replyTargetIsNod?: boolean } = {}) {
  return isAddressedToNod(msg(text, over), { selfPhone: NOD, classify: never, ...extra });
}

describe("isAddressedToNod: certain triggers", () => {
  it.each([
    "@Nod what do you think",
    "what about this one @Nod?",
    "@nod",
    "@NOD!!!",
    "@nOd pick one",
    "ok so @Nod.",
    "(@Nod) thoughts",
  ])("@mention in text: %j", async (text) => {
    expect(await check(text)).toEqual({ addressed: true, reason: "mention", tier: "certain" });
  });

  it("a real iMessage mention of Nod's contact, whatever the text says", async () => {
    expect(await check("can Nod pick for us", { mentions: [NOD] })).toMatchObject({ addressed: true, reason: "mention" });
  });

  it.each([
    "Nod, book the 8pm",
    "Nod book it",
    "nod: which one is cheaper",
    "NOD what's the tab",
    "  Nod?",
    "Nod!",
    "Nod.",
    "Nod",
    "Nod's pick?",
    "Nod’s pick?",
    "Nod — split this 4 ways",
  ])("first word: %j", async (text) => {
    expect(await check(text)).toEqual({ addressed: true, reason: "first_word", tier: "certain" });
  });

  it.each([
    "hey Nod",
    "hey nod which one",
    "yo Nod, split this",
    "hi NOD",
    "ok Nod lock it in",
    "okay Nod",
    "hello Nod",
    "so, hey Nod, thoughts?",
    "Hey, Nod what's the total",
    "alright guys. yo nod",
  ])("greeting before the name: %j", async (text) => {
    expect(await check(text)).toEqual({ addressed: true, reason: "greeting", tier: "certain" });
  });

  it("an inline reply to one of Nod's messages", async () => {
    expect(await check("yes that one", { replyToMessageId: "m0" }, { replyTargetIsNod: true })).toEqual({
      addressed: true,
      reason: "reply_to_nod",
      tier: "certain",
    });
  });

  it("an inline reply to someone else's message is not a call by itself", async () => {
    expect(await check("yes that one", { replyToMessageId: "m0" }, { replyTargetIsNod: false })).toMatchObject({
      addressed: false,
      reason: "no_name",
    });
  });

  it.each(["hello", "he gave me the nod", "", "start a group for Tulum"])("any private message: %j", async (text) => {
    expect(await check(text, { groupId: null })).toEqual({ addressed: true, reason: "private", tier: "certain" });
  });

  it("works on SMS text too (no real mentions there)", async () => {
    expect(await check("@Nod what time", { service: "sms" })).toMatchObject({ addressed: true, reason: "mention" });
  });
});

describe("isAddressedToNod: never a trigger", () => {
  it.each([
    "I'm nodding off",
    "nodding along",
    "Nodding is rude",
    "she nods",
    "no dice",
    "node.js is great",
    "Snod",
    "@Nodbot help",
    "canod",
    "totally unrelated message",
  ])("no standalone 'nod': %j", async (text) => {
    expect(await check(text)).toEqual({ addressed: false, reason: "no_name", tier: "none" });
  });

  it.each([
    "https://nod.example.com/listing/123",
    "check airbnb.com/rooms/nod-house",
    "http://example.com/?q=hey%20nod",
    "email bob@nod.co about it",
  ])("'nod' only inside a link or email: %j", async (text) => {
    expect(await check(text)).toEqual({ addressed: false, reason: "no_name", tier: "none" });
  });

  it("a link plus a real mention still counts", async () => {
    expect(await check("@Nod https://nod.example.com/x")).toMatchObject({ addressed: true, reason: "mention" });
  });

  it("messages from Nod itself, even in a private thread", async () => {
    expect(await check("@Nod here", { from: NOD })).toEqual({ addressed: false, reason: "from_nod", tier: "none" });
    expect(await check("hey", { from: NOD, groupId: null })).toMatchObject({ addressed: false, reason: "from_nod" });
  });

  it.each([
    "Liked “@Nod book it”",
    "Loved “Nod, pick one”",
    "Disliked “hey Nod”",
    "Laughed at “ok nod”",
    "Emphasized \"@Nod\"",
    "Questioned “Nod?”",
    "Removed a heart from “hey Nod”",
    "Removed a like from “@Nod which one”",
    "Reacted 👍 to “@Nod book it”",
  ])("SMS tapback text quoting a call: %j", async (text) => {
    expect(await check(text, { service: "sms" })).toEqual({ addressed: false, reason: "tapback_text", tier: "none" });
  });

  it("empty or media-only messages", async () => {
    expect(await check("", { mediaUrls: ["https://x/y.jpg"] })).toEqual({ addressed: false, reason: "no_name", tier: "none" });
  });
});

describe("isAddressedToNod: ambiguous goes to the classifier", () => {
  it.each(["he gave me the nod", "I'll nod along", "just nod and smile", "Nod off, it's late", "nod along with it", "okay nod along"])(
    "%j asks the classifier and respects no",
    async (text) => {
      const classify = vi.fn(async () => false);
      const d = await isAddressedToNod(msg(text), { selfPhone: NOD, classify });
      expect(d).toEqual({ addressed: false, reason: "classifier_no", tier: "ambiguous" });
      expect(classify).toHaveBeenCalledTimes(1);
      expect(classify).toHaveBeenCalledWith({ text, recent: [] });
    },
  );

  it.each(["should we ask nod?", "what does nod think", "can nod split this"])("%j responds on a clear yes", async (text) => {
    const d = await isAddressedToNod(msg(text), { selfPhone: NOD, classify: async () => true });
    expect(d).toEqual({ addressed: true, reason: "classifier_yes", tier: "ambiguous" });
  });

  it("passes recent context to the classifier", async () => {
    const classify = vi.fn(async () => true);
    const recent = [{ from: "Jake", text: "who's booking" }];
    await isAddressedToNod(msg("maybe nod can"), { selfPhone: NOD, classify, recent });
    expect(classify).toHaveBeenCalledWith({ text: "maybe nod can", recent });
  });

  it("stays silent when the classifier fails", async () => {
    const d = await isAddressedToNod(msg("gave me the nod"), {
      selfPhone: NOD,
      classify: async () => {
        throw new Error("timeout");
      },
    });
    expect(d).toEqual({ addressed: false, reason: "classifier_error", tier: "ambiguous" });
  });

  it("never calls the classifier for certain or impossible cases", async () => {
    const classify = vi.fn(async () => true);
    for (const text of ["@Nod hi", "Nod book it", "hey nod", "nodding", "https://nod.com"]) {
      await isAddressedToNod(msg(text), { selfPhone: NOD, classify });
    }
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("detectAddress (sync first pass)", () => {
  it("returns ambiguous without deciding", () => {
    expect(detectAddress(msg("gave me the nod"), { selfPhone: NOD })).toEqual({ tier: "ambiguous" });
    expect(detectAddress(msg("@Nod"), { selfPhone: NOD })).toEqual({ tier: "certain", reason: "mention" });
    expect(detectAddress(msg("nodding"), { selfPhone: NOD })).toEqual({ tier: "none", reason: "no_name" });
  });
});

describe("isAddressedToNod: follow-up answers to Nod's question", () => {
  const Q = "Jake, what's the nightly price on Casa Azul?";
  const ctxWith = (answer: boolean | Error, extra: Record<string, unknown> = {}) => {
    const classifyAnswer = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const classify = vi.fn(async () => false);
    return { ctx: { selfPhone: NOD, classify, classifyAnswer, pendingQuestion: Q, ...extra }, classifyAnswer, classify };
  };

  it("treats a plain answer from the person Nod asked as a call", async () => {
    const { ctx, classifyAnswer } = ctxWith(true);
    expect(await isAddressedToNod(msg("$310 a night"), ctx)).toEqual({ addressed: true, tier: "followup", reason: "answer_to_nod" });
    expect(classifyAnswer).toHaveBeenCalledWith({ question: Q, answer: "$310 a night" });
  });

  it("stays silent when the message isn't an answer", async () => {
    const { ctx } = ctxWith(false);
    expect(await isAddressedToNod(msg("lol ok grabbing dinner"), ctx)).toEqual({ addressed: false, tier: "followup", reason: "not_an_answer" });
  });

  it("stays silent when the answer check fails", async () => {
    const { ctx } = ctxWith(new Error("timeout"));
    expect(await isAddressedToNod(msg("310"), ctx)).toEqual({ addressed: false, tier: "followup", reason: "answer_check_error" });
  });

  it("doesn't need the check for messages that already call Nod", async () => {
    const { ctx, classifyAnswer } = ctxWith(true);
    expect(await isAddressedToNod(msg("@Nod it's $310"), ctx)).toMatchObject({ tier: "certain", reason: "mention" });
    expect(classifyAnswer).not.toHaveBeenCalled();
  });

  it("never counts tapback text, Nod's own messages, or empty messages", async () => {
    const { ctx, classifyAnswer } = ctxWith(true);
    expect(await isAddressedToNod(msg("Liked “Jake, what's the price?”", { service: "sms" }), ctx)).toMatchObject({ reason: "tapback_text" });
    expect(await isAddressedToNod(msg("310", { from: NOD }), ctx)).toMatchObject({ reason: "from_nod" });
    expect(await isAddressedToNod(msg("", { mediaUrls: ["https://x/y.jpg"] }), ctx)).toMatchObject({ addressed: false, reason: "no_name" });
    expect(classifyAnswer).not.toHaveBeenCalled();
  });

  it("does nothing without an open question", async () => {
    const { ctx, classifyAnswer } = ctxWith(true, { pendingQuestion: undefined });
    expect(await isAddressedToNod(msg("$310 a night"), ctx)).toEqual({ addressed: false, reason: "no_name", tier: "none" });
    expect(classifyAnswer).not.toHaveBeenCalled();
  });

  it("checks for an answer first, then the usual ambiguous-'nod' check", async () => {
    const yes = ctxWith(true);
    expect(await isAddressedToNod(msg("I'd give Casa Azul the nod, $310"), yes.ctx)).toMatchObject({ addressed: true, tier: "followup" });
    expect(yes.classify).not.toHaveBeenCalled();

    const no = ctxWith(false);
    no.classify.mockResolvedValueOnce(true);
    expect(await isAddressedToNod(msg("should we ask nod about dinner"), no.ctx)).toMatchObject({ addressed: true, tier: "ambiguous", reason: "classifier_yes" });
  });
});
