// Getting Nod into groups and into people's contacts (CLAUDE.md, "Getting Nod into a group"):
// the group introduction, access and can't-work-here notes, personal setup,
// resending the contact card, and the "start a group" fallback.

import type { Store, User } from "../db/store";
import type { AddressedCall, JoinCall } from "../inbound/pipeline";
import type { Logger } from "../lib/log";
import type { ContactCard, MessagingProvider, Phone } from "../messaging/types";
import { copy } from "./copy";
import { isCardRequest, normalizePhone, parseStartGroup } from "./text";

export interface OnboardingConfig {
  /** The five-second screen recording: tap the group name, Add Contact, type Nod. */
  howToVideoUrl: string;
  /** Nod's logo, used as the contact card photo. */
  logoUrl?: string;
}

export interface OnboardingDeps {
  store: Store;
  provider: MessagingProvider;
  config: OnboardingConfig;
  logger: Logger;
  now?: () => Date;
}

/** Sendblue groups take up to 25 numbers, the requester included. */
const MAX_OTHERS = 24;
/** How long a "want me to start a new group?" offer stays open. */
const OFFER_DAYS = 7;

export function createOnboarding(deps: OnboardingDeps) {
  const { store, provider, config, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const card = (): ContactCard => ({ name: "Nod", phone: provider.selfPhone, ...(config.logoUrl ? { photoUrl: config.logoUrl } : {}) });
  const dm = (phone: Phone, text: string) => provider.send({ phone }, { text });

  async function onJoined(join: JoinCall): Promise<void> {
    const group = await store.getGroup(join.groupId);
    if (!group) return;
    const adder = join.addedByUserId ? await store.getUser(join.addedByUserId) : undefined;

    if (join.via === "join_event" && join.service === "sms") {
      await store.markUnsupported(group.id);
      if (adder) await dm(adder.phone, copy.cantWorkHere(group.name));
      logger.info("onboarding.unsupported_group", { groupId: group.id, offered: !!adder });
      return;
    }

    if (!(await store.claimIntro(group.id))) return;
    const lead = join.via === "join_event" && adder?.name ? copy.addedBy(adder.name) : copy.neutralLead;
    try {
      await provider.send({ groupId: join.providerGroupId }, { text: copy.intro(lead), contactCard: card() });
    } catch (err) {
      await store.resetIntro(group.id); // let the next event try again
      throw err;
    }
    logger.info("onboarding.intro_sent", { groupId: group.id, via: join.via });

    if (adder && adder.accessStatus !== "active") {
      await store.joinWaitlist(adder.phone);
      await dm(adder.phone, copy.accessNeeded(group.name));
      logger.info("onboarding.access_note_sent", { groupId: group.id });
    }
  }

  async function onLeft({ groupId }: { groupId: string }): Promise<void> {
    await store.resetIntro(groupId); // a later re-add gets a fresh introduction
  }

  /** The private welcome: card, how-to video, privacy note. Invites call this with a lead ("You're in.") when someone gets access. */
  async function personalSetup(user: User, opts: { lead?: string; invites?: number } = {}): Promise<void> {
    const welcome = opts.lead ? copy.welcomeIn(opts.lead, opts.invites ?? 0) : copy.setupWelcome;
    await provider.send({ phone: user.phone }, { text: welcome, contactCard: card() });
    await provider.send({ phone: user.phone }, { text: copy.setupHowTo, mediaUrls: [config.howToVideoUrl] });
    await provider.send({ phone: user.phone }, { text: copy.setupPrivacy });
    logger.info("onboarding.setup_sent", { userId: user.id });
  }

  /** Returns true when onboarding handled the call, so the orchestrator shouldn't. */
  async function handleAddressed(call: AddressedCall): Promise<boolean> {
    const { event } = call;
    const user = await store.getUser(call.senderUserId);
    if (!user) return false;
    if (event.contactCards?.length) await store.saveContacts(user.id, event.contactCards);

    if (event.groupId !== null) {
      if (!isCardRequest(event.text)) return false;
      await provider.send({ groupId: event.groupId }, { text: copy.card, contactCard: card() });
      return true;
    }

    let setupJustSent = false;
    if (user.accessStatus === "active" && (await store.claimSetup(user.id))) {
      await personalSetup(user);
      setupJustSent = true;
    }
    const start = parseStartGroup(event.text);
    if (start) {
      await startGroup(user, start);
      return true;
    }
    if (isCardRequest(event.text)) {
      if (!setupJustSent) await provider.send({ phone: user.phone }, { text: copy.card, contactCard: card() });
      return true;
    }
    return false;
  }

  async function startGroup(user: User, request: { name?: string; people: string[] }): Promise<void> {
    if (user.accessStatus !== "active") {
      await store.joinWaitlist(user.phone);
      return void (await dm(user.phone, copy.startNeedsAccess));
    }

    let name = request.name;
    const phones = new Set<Phone>();
    if (!request.people.length) {
      const since = new Date(now().getTime() - OFFER_DAYS * 86_400_000);
      const offered = await store.latestUnsupportedGroupFor(user.id, since);
      if (!offered) return void (await dm(user.phone, copy.startWho));
      for (const p of await store.memberPhones(offered.id)) phones.add(p);
      name ??= offered.name ?? undefined;
    } else {
      const unknown: string[] = [];
      for (const who of request.people) {
        const asPhone = normalizePhone(who);
        if (asPhone) {
          phones.add(asPhone);
          continue;
        }
        const matches = await store.findKnownPeople(user.id, who);
        if (matches.length > 1) return void (await dm(user.phone, copy.startAmbiguous(who)));
        if (matches.length === 0) unknown.push(who);
        else phones.add(matches[0]!.phone);
      }
      if (unknown.length) return void (await dm(user.phone, copy.startUnknown(unknown)));
    }

    phones.delete(user.phone);
    phones.delete(provider.selfPhone);
    if (phones.size === 0) return void (await dm(user.phone, copy.startWho));
    if (phones.size > MAX_OTHERS) return void (await dm(user.phone, copy.startTooMany));

    const lead = user.name ? copy.askedToStart(user.name) : copy.neutralAskedToStart;
    const created = await provider.createGroup({
      members: [user.phone, ...phones],
      name,
      ...(config.logoUrl ? { photoUrl: config.logoUrl } : {}),
      firstMessage: { text: copy.intro(lead), contactCard: card() },
    });
    const { group } = await store.upsertGroup({ provider: provider.name, providerGroupId: created.groupId, name });
    await store.markCreatedByNod(group.id, user.id);
    logger.info("onboarding.group_created", { groupId: group.id, members: phones.size + 1, service: created.service });
  }

  return { onJoined, onLeft, handleAddressed, personalSetup, card };
}

export type Onboarding = ReturnType<typeof createOnboarding>;
