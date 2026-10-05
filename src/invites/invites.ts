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

import { defineTool, type NodTool } from "../agent/tools";
import type { InviteSource, Store, User } from "../db/store";
import type { AddressedCall } from "../inbound/pipeline";
import type { Logger } from "../lib/log";
import type { MessagingProvider, Phone } from "../messaging/types";
import type { Onboarding } from "../onboarding/onboarding";
import { findCode, generateCode, type RandomBytes } from "./codes";

export interface InvitesDeps {
  store: Store;
  provider: MessagingProvider;
  onboarding: Pick<Onboarding, "personalSetup">;
  logger: Logger;
  appUrl?: string;
  now?: () => Date;
  random?: RandomBytes;
}

/** Invites each person gets to share when they get access. */
export const INVITES_PER_PERSON = 3;
/** Wrong codes allowed per phone per day, so codes can't be guessed. */
const MAX_FAILED_CODES = 5;
const DAY = 86_400_000;
/** Trips that ended this recently still get post-trip codes (covers a missed daily sweep). */
const WRAP_LOOKBACK_DAYS = 3;
/** Only trips of at least two calendar days count (a one-night stay spans two). */
const MIN_TRIP_DAYS = 2;

export const inviteCopy = {
  waitlistJoined:
    "Hi, I'm Nod. I help group chats pick, book and split the cost of things. I'm invite-only for now, so you're on the waitlist and I'll text you when a spot opens. Got a code? Send it here.",
  stillWaiting: "You're still on the waitlist, and I'll text you the moment a spot opens. Got an invite code? Send it here.",
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
    const code = findCode(call.event.text);
    if (code) {
      if (user.accessStatus === "active") await dm(user.phone, inviteCopy.alreadyIn);
      else await redeem(user, code);
      return true;
    }
    if (user.accessStatus === "active") return false;
    if ((await store.groupsForUser(user.id)).length > 0) return false; // a member: votes, pay links, questions
    const { created } = await store.joinWaitlist(user.phone);
    if (created) logger.info("invites.waitlist_joined", { userId: user.id });
    await dm(user.phone, created ? inviteCopy.waitlistJoined : inviteCopy.stillWaiting);
    return true;
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
  return { handlePrivate, tools, sweepTrips, createCodes, releaseWaitlist };
}

export type Invites = ReturnType<typeof createInvites>;
