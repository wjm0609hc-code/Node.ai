// Invites (Phase 1 step 16): who can add Nod to new groups and start groups.
//
// - Texting Nod without access puts you on the waitlist; texting a code gets you in.
//   Texting the code yourself proves the phone is yours, so the /join page only
//   hands the code to the Messages app.
// - Everyone who gets in has a few invites to share ("@Nod give me an invite").
// - The day after a multi-day trip ends, everyone in that group gets one code to pass on.
// - Admins create codes and let people in off the waitlist (scripts/invites.ts).
//
// Access never limits what people can do inside a group Nod is already in (rule 6):
// members without access still vote, pay and ask questions, in the group or privately.
//
// Ways in (see the sign-up map in CLAUDE.md):
// - The home page: name and number, then Nod texts them (signUpFromWeb).
// - From a group Nod is in: tapping ❤️ on Nod's introduction, texting Nod privately, or
//   adding Nod to a group. With `groupSignup: "access"` (the default) being in a group with
//   Nod is as good as an invite; with "waitlist" they join the waitlist instead.
// - Texting Nod out of the blue (the waitlist), or texting a code.
// - STOP / START in a private chat turns Nod's private texts off and on (src/messaging/stop-guard.ts).

import { defineTool, type NodTool } from "../agent/tools";
import type { InviteSource, SignupSource, Store, User } from "../db/store";
import type { AddressedCall, MessageCall } from "../inbound/pipeline";
import type { Logger } from "../lib/log";
import type { InboundReaction, MessagingProvider, Phone } from "../messaging/types";
import { copy as onboardingCopy } from "../onboarding/copy";
import { parseTapbackText } from "../voting/votes";
import type { Onboarding } from "../onboarding/onboarding";
import { findCode, generateCode, type RandomBytes } from "./codes";
import { introducedName, isJustHello, nameReply, stopWord } from "./names";

export interface InvitesDeps {
  store: Store;
  provider: MessagingProvider;
  onboarding: Pick<Onboarding, "personalSetup">;
  logger: Logger;
  appUrl?: string;
  now?: () => Date;
  random?: RandomBytes;
  /** What being in a group with Nod gets people: access right away (default), or a place on the waitlist. */
  groupSignup?: GroupSignup;
  /** Where people can get help (NOD_CONTACT_EMAIL), for the HELP reply. */
  contactEmail?: string;
}

export type GroupSignup = "access" | "waitlist";

/** Invites each person gets to share when they get access. */
export const INVITES_PER_PERSON = 3;
/** Wrong codes allowed per phone per day, so codes can't be guessed. */
const MAX_FAILED_CODES = 5;
const DAY = 86_400_000;
/** Trips that ended this recently still get post-trip codes (covers a missed daily sweep). */
const WRAP_LOOKBACK_DAYS = 3;
/** Only trips of at least two calendar days count (a one-night stay spans two). */
const MIN_TRIP_DAYS = 2;
/** Tapbacks on Nod's introduction that mean "sign me up". */
const SIGNUP_TAPBACKS = new Set(["love", "like", "emphasize"]);

/** Nod's group introduction, in full or as an SMS tapback quotes it (often cut short). */
function isIntro(text: string): boolean {
  // The other checks keep tapbacks on intros sent before the copy changed working.
  return (
    text.includes(onboardingCopy.signupInvite) ||
    text.includes("on this for me in your own chats") ||
    text.includes("Tag @Nod when you need me")
  );
}

export const inviteCopy = {
  /** Two texts: the welcome, then how to skip the wait. */
  waitlistJoined: (name: string | null): [string, string] => [
    `Hey${name ? ` ${name}` : ""}! So glad you found me. You're on the waitlist for now: I'm letting people in a few at a time so I stay fast and reliable in every chat. I'll text you right here the moment a spot opens. You don't need to do anything else.`,
    `Know someone who already uses me? That's the way to skip the wait. They can text me "give me an invite" and send you the code. Text it here from this number and you're in.`,
  ],
  stillWaiting: "You're still on the waitlist, and I'll text you the moment a spot opens. Got an invite code? Send it here.",
  /** Added to the last text when Nod texts first (a home-page sign-up), so people can opt out. */
  optOut: " Reply STOP to stop texts.",
  stopped: "Done. You won't get any more texts from me. Text START if you change your mind.",
  started: "Welcome back. I can text you again.",
  help: (email: string | undefined, appUrl: string | undefined) =>
    `Nod: an assistant for your group chats. Help: ${email ?? (appUrl ? `${appUrl}/terms` : "reply here")}. Msg frequency varies. Msg & data rates may apply. Reply STOP to stop texts.`,
  alreadyInWeb: "You're already in, so no need to sign up again. Text me anytime, or add me to a group: tap the group name, tap Add Contact, then type Nod.",
  adderLead: (groupName: string | null) => `Thanks for adding me to ${groupName ?? "the group"}. You're all set to use me in any chat.`,
  codeUnknown: "Hmm, that code doesn't match an invite. Double-check it and send it again.",
  codeUsed: "That code's already been used. Ask whoever sent it for a fresh one.",
  tooManyTries: "That's a few codes that didn't work, so let's pause there. Try again tomorrow.",
  alreadyIn: "You're already in, so save that code for a friend.",
  inLead: "You're in.",
  releasedLead: "A spot opened up, so you're in.",
  used: (name: string | null) => (name ? `${name} just joined with your invite.` : "Someone just joined with your invite."),
  memberCode: (code: string, link: string | null, left: number) =>
    `Here's an invite for a friend: ${code}. They can text it to me${link ? ` or open ${link}` : ""}. ${left === 0 ? "That was your last one." : `You have ${left} left.`}`,
  postTrip: (place: string, code: string, link: string | null, hasAccess: boolean) =>
    hasAccess
      ? `Hope ${place} was a great trip. Here's an invite to pass on to a friend: ${code}${link ? ` (${link})` : ""}.`
      : `Hope ${place} was a great trip. Here's an invite code: ${code}. Text it back to me to use me in your own groups, or pass it to a friend${link ? ` (${link})` : ""}.`,
};

export function createInvites(deps: InvitesDeps) {
  const { store, provider, onboarding, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const dm = (phone: Phone, text: string) => provider.send({ phone }, { text });
  const joinLink = (code: string) => (deps.appUrl ? `${deps.appUrl}/join?code=${code}` : null);

  /** A fresh code. Collisions are vanishingly rare; retry a few times anyway. */
  async function issue(issuedByUserId: string | null, source: InviteSource, eventId?: string) {
    for (let i = 0; i < 5; i++) {
      const invite = await store.createInvite({ code: generateCode(deps.random), issuedByUserId, source, eventId });
      if (invite) return invite;
    }
    throw new Error("could not create a unique invite code");
  }

  /** Gives access, the person's own invites, and the welcome (once). */
  async function admit(user: User, lead: string): Promise<void> {
    await store.setUserAccess(user.id, "active");
    await store.setInvitesRemaining(user.id, INVITES_PER_PERSON);
    await store.leaveWaitlist(user.phone);
    if (await store.claimSetup(user.id)) await onboarding.personalSetup(user, { lead, invites: INVITES_PER_PERSON });
    else await dm(user.phone, `${lead} You've got ${INVITES_PER_PERSON} invites for friends whenever you want one.`);
  }

  async function redeem(user: User, code: string): Promise<void> {
    const entry = await store.waitlistEntry(user.phone);
    const windowStart = new Date(now().getTime() - DAY);
    if (entry?.failedSince && entry.failedSince >= windowStart && entry.failedCodes >= MAX_FAILED_CODES) {
      return void (await dm(user.phone, inviteCopy.tooManyTries));
    }
    const invite = await store.redeemInvite(code, user.id);
    if (!invite) {
      const known = await store.inviteByCode(code);
      await store.recordFailedCode(user.phone, windowStart);
      logger.info("invites.redeem_failed", { userId: user.id, reason: known ? "used" : "unknown" });
      return void (await dm(user.phone, known ? inviteCopy.codeUsed : inviteCopy.codeUnknown));
    }
    await admit(user, inviteCopy.inLead);
    logger.info("invites.redeemed", { userId: user.id, source: invite.source });
    const issuer = invite.issuedByUserId ? await store.getUser(invite.issuedByUserId) : undefined;
    if (issuer && issuer.id !== user.id) await dm(issuer.phone, inviteCopy.used(user.name));
  }

  /**
   * Private messages about access. Returns true when handled here, so nothing else answers.
   * Codes are always handled; a message from someone without access who isn't in any
   * chat with Nod gets the waitlist reply. Everyone else carries on as normal.
   */
  async function handlePrivate(call: AddressedCall): Promise<boolean> {
    if (call.event.groupId !== null) return false;
    const user = await store.getUser(call.senderUserId);
    if (!user) return false;
    const stop = stopWord(call.event.text);
    if (stop === "stop") {
      if (!user.textsStoppedAt) {
        await dm(user.phone, inviteCopy.stopped); // the one confirmation, then nothing
        await store.setTextsStopped(user.id, true);
        logger.info("invites.texts_stopped", { userId: user.id });
      }
      return true;
    }
    if (stop === "help") {
      await provider.send({ phone: user.phone }, { text: inviteCopy.help(deps.contactEmail, deps.appUrl), allowWhenStopped: true });
      return true;
    }
    if (stop === "start") {
      if (user.textsStoppedAt) {
        await store.setTextsStopped(user.id, false);
        await dm(user.phone, inviteCopy.started);
        logger.info("invites.texts_started", { userId: user.id });
      }
      return true;
    }
    if (user.textsStoppedAt) return true; // nothing goes out until they text START

    // The answer to "what should I call you?" (asked once in the welcome, good for a week).
    if (!user.name && user.nameAskedAt && now().getTime() - user.nameAskedAt.getTime() < 7 * DAY) {
      const name = nameReply(call.event.text);
      if (name) {
        await store.setUserName(user.id, name);
        await store.setNameAsked(user.id, null);
        await dm(user.phone, onboardingCopy.nameSaved(name));
        logger.info("invites.name_saved", { userId: user.id });
        return true;
      }
    }

    const code = findCode(call.event.text);
    if (code) {
      if (user.accessStatus === "active") await dm(user.phone, inviteCopy.alreadyIn);
      else await redeem(user, code);
      return true;
    }
    if (user.accessStatus === "active") return false;

    let named = user;
    const given = user.name ? null : introducedName(call.event.text);
    if (given) {
      await store.setUserName(user.id, given); // "Hey Nod! I'm Will."
      named = { ...user, name: given };
    }
    if ((await store.groupsForUser(user.id)).length > 0) {
      // In a group with Nod: texting it is signing up. Votes, pay links and questions carry on either way (rule 6).
      if (groupSignup === "waitlist") return false;
      await signUpFromGroup(named);
      return isJustHello(call.event.text); // a plain "hey" needs nothing more than the welcome
    }
    await waitlist(named, "text");
    return true;
  }

  const groupSignup: GroupSignup = deps.groupSignup ?? "access";

  /** Waitlist texts for someone who just signed up (two the first time, one after). */
  async function waitlist(user: User, source: SignupSource, opts: { optOut?: boolean } = {}): Promise<void> {
    const { created } = await store.joinWaitlist(user.phone, source);
    if (!created) return void (await dm(user.phone, inviteCopy.stillWaiting + (opts.optOut ? inviteCopy.optOut : "")));
    logger.info("invites.waitlist_joined", { userId: user.id, source });
    const [welcome, skip] = inviteCopy.waitlistJoined(user.name);
    await dm(user.phone, welcome);
    await dm(user.phone, skip + (opts.optOut ? inviteCopy.optOut : ""));
  }

  /**
   * Someone in a group with Nod asked for their own Nod (a tapback on the intro, or a private
   * text). With group sign-up on they're in right away and get the personal setup (welcome,
   * contact card, how-to video, privacy note); otherwise they join the waitlist.
   */
  async function signUpFromGroup(user: User, opts: { lead?: string } = {}): Promise<"admitted" | "waitlisted" | "already"> {
    if (user.accessStatus === "active") {
      if (await store.claimSetup(user.id)) await onboarding.personalSetup(user);
      return "already";
    }
    if (groupSignup === "waitlist") {
      await waitlist(user, "group");
      return "waitlisted";
    }
    await admit(user, opts.lead ?? inviteCopy.inLead);
    logger.info("invites.group_signup", { userId: user.id });
    return "admitted";
  }

  /** A tapback on Nod's introduction ("Tap 👍 or ❤️ on this…") signs that person up, privately. */
  async function onReaction(call: { event: InboundReaction; groupId: string; userId: string }): Promise<void> {
    if (call.event.removed || !SIGNUP_TAPBACKS.has(call.event.reaction)) return;
    const text = await store.nodMessageText(call.groupId, call.event.targetMessageId);
    if (!text || !isIntro(text)) return;
    const user = await store.getUser(call.userId);
    if (user) await signUpFromGroup(user);
  }

  /** The SMS form of that tapback: `Loved “Will added me. Tag @Nod…”`. */
  async function captureTapback(call: MessageCall): Promise<void> {
    if (!call.groupId) return;
    const parsed = parseTapbackText(call.event.text);
    if (!parsed || parsed.removed || !SIGNUP_TAPBACKS.has(parsed.reaction) || !isIntro(parsed.quoted)) return;
    const user = await store.getUser(call.senderUserId);
    if (user) await signUpFromGroup(user);
  }

  /** Whoever added Nod to a group, without access yet. */
  async function adderWithoutAccess(user: User, groupName: string | null): Promise<void> {
    if (groupSignup === "waitlist") {
      await store.joinWaitlist(user.phone, "group");
      return void (await dm(user.phone, onboardingCopy.accessNeeded(groupName)));
    }
    await signUpFromGroup(user, { lead: inviteCopy.adderLead(groupName) });
  }

  /**
   * A home-page sign-up (the page has already checked the number and its limits). Nod texts
   * first here, so the last text says how to opt out, and nothing goes to someone who texted STOP.
   */
  async function signUpFromWeb(input: { phone: Phone; name?: string | null }): Promise<void> {
    let user = await store.upsertUser(input.phone);
    if (user.textsStoppedAt) return;
    if (input.name && !user.name) {
      await store.setUserName(user.id, input.name);
      user = { ...user, name: input.name };
    }
    if (user.accessStatus === "active") return void (await dm(user.phone, inviteCopy.alreadyInWeb));
    if ((await store.groupsForUser(user.id)).length > 0) {
      await signUpFromGroup(user);
      return;
    }
    await waitlist(user, "web", { optOut: true });
  }

  const getInvite = defineTool<Record<string, never>>({
    name: "get_invite",
    description:
      "When someone asks for an invite code for a friend, or asks how to get access to Nod for themselves. Sends the caller a code privately " +
      "(or, without access, puts them on the waitlist). Never repeat a code in the group. In the group, say you sent it privately; in a private " +
      "chat the code is already sent, so reply with nothing.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_input, ctx) {
      const user = await store.getUser(ctx.caller.userId);
      if (!user) return "Couldn't find the caller.";
      if (user.accessStatus !== "active") {
        await store.joinWaitlist(user.phone);
        return `${ctx.caller.name} doesn't have access yet, so has no invites to give. They're on the waitlist; Nod will text them when a spot opens, or they can text Nod a code from a friend. They can still use Nod in this chat.`;
      }
      if (!(await store.takeInvite(user.id))) return `${ctx.caller.name} has used all their invites.`;
      const invite = await issue(user.id, "member");
      const left = (await store.getUser(user.id))?.invitesRemaining ?? 0;
      await dm(user.phone, inviteCopy.memberCode(invite.code, joinLink(invite.code), left));
      logger.info("invites.member_code", { userId: user.id, left });
      return ctx.chat.kind === "group" ? `Sent ${ctx.caller.name} a code privately (${left} left).` : "Sent the code. Reply with nothing.";
    },
  });

  /**
   * Daily: the day after a multi-day trip ends, each member gets one code to pass on.
   * Each member's code is marked sent on its own and the trip is marked done only at the end,
   * so if a send fails, the job's retry (or tomorrow's run) texts just the people still missing one.
   */
  async function sweepTrips(): Promise<number> {
    const until = now();
    const since = new Date(until.getTime() - WRAP_LOOKBACK_DAYS * DAY);
    let sent = 0;
    for (const event of await store.endedTrips(since, until)) {
      const group = await store.getGroup(event.groupId);
      const isTrip = event.endsAt.getTime() - event.startsAt.getTime() >= MIN_TRIP_DAYS * DAY;
      if (!isTrip || !group?.introSentAt) {
        await store.claimEventWrap(event.id); // nothing to send (too short, or Nod was removed)
        continue;
      }
      const place = group.name ?? event.title;
      for (const member of await store.groupMembers(group.id)) {
        let invite = await store.postTripInvite(event.id, member.userId);
        if (invite?.notifiedAt) continue; // already texted on an earlier run
        if (!invite) {
          if ((await store.unredeemedInvites(member.userId, "post_trip")).length > 0) continue; // still holding one
          invite = await issue(member.userId, "post_trip", event.id);
        }
        const user = await store.getUser(member.userId);
        if (!user) continue;
        await dm(user.phone, inviteCopy.postTrip(place, invite.code, joinLink(invite.code), user.accessStatus === "active"));
        await store.markInviteNotified(invite.id);
        sent++;
      }
      await store.claimEventWrap(event.id);
      logger.info("invites.post_trip", { groupId: group.id, eventId: event.id });
    }
    return sent;
  }

  /** Admin: codes to hand out by hand. */
  async function createCodes(count: number): Promise<string[]> {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) codes.push((await issue(null, "manual")).code);
    return codes;
  }

  /** Admin: let the next people in off the waitlist. They texted Nod, so their phone is proven; no code needed. */
  async function releaseWaitlist(count: number): Promise<number> {
    let admitted = 0;
    for (const entry of await store.nextOnWaitlist(count)) {
      await store.markWaitlistNotified(entry.phone);
      const user = await store.upsertUser(entry.phone);
      if (user.accessStatus === "active") {
        await store.leaveWaitlist(user.phone);
        continue;
      }
      await admit(user, inviteCopy.releasedLead);
      admitted++;
    }
    logger.info("invites.waitlist_released", { admitted });
    return admitted;
  }

  const tools: NodTool<any>[] = [getInvite];
  return { handlePrivate, onReaction, captureTapback, adderWithoutAccess, signUpFromWeb, signUpFromGroup, tools, sweepTrips, createCodes, releaseWaitlist };
}

export type Invites = ReturnType<typeof createInvites>;
