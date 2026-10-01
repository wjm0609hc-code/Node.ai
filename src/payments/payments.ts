// Group payments (Phase 1 step 10). Someone asks Nod to collect money ("@Nod
// collect $310 each for Casa Azul"); each payer gets a private pay link; their
// card is held (authorized) on the payee's own Stripe account when they pay; and
// every card is charged (captured) only once everyone has paid and the group's
// spending rules are met. If the deadline passes first, every hold is released.
//
// Rules this keeps:
//   3. Pay links, reminders and who-hasn't-paid go to people privately. The group
//      only hears the request, counts, and the outcome.
//   4. The group is told the amount before anyone pays, and nothing is captured
//      until the spending rules are met. Paying your share counts as approving it.
//   5. Money goes straight to the payee's Stripe account (direct charges); Nod's
//      platform never holds it.

import { cardContent, type Cards } from "../cards/cards";
import type { ContextSection } from "../agent/context";
import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool, type ToolContext } from "../agent/tools";
import { resolveMember } from "../agent/tools/members";
import { approvalRequirement, isApproved, readSpendRules, type ApprovalRequirement } from "../booking/approvals";
import { money } from "../booking/shared";
import type { ChatMember, Group, PaymentCollection, PaymentRequest, Store, User } from "../db/store";
import type { MessageCall } from "../inbound/pipeline";
import type { PaymentJob, Scheduler } from "../jobs/scheduler";
import type { Logger } from "../lib/log";
import { formatLocal, localDateTimeToUtc } from "../lib/time";
import type { InboundReaction, MessagingProvider, Tapback } from "../messaging/types";
import { parseTapbackText } from "../voting/votes";
import { CardError, type PaymentGateway } from "./gateway";
import { splitShares, SplitError } from "./split";

export interface PaymentsDeps {
  store: Store;
  provider: MessagingProvider;
  gateway: PaymentGateway;
  scheduler: Scheduler;
  logger: Logger;
  defaultTimezone: string;
  /** Public web app URL: pay links are {appUrl}/pay/{token}, payout setup {appUrl}/connect/{token}. */
  appUrl?: string;
  now?: () => Date;
  /** Unguessable link tokens; injectable for tests. */
  newToken?: () => string;
  /** Called after each share is charged (the tab records settle-up payments here). */
  onRequestCaptured?: (collection: PaymentCollection, request: PaymentRequest) => Promise<void>;
  /** With cards, pay links go out as a "Pay your share" card that opens the pay page; without, as a link in the text. */
  cards?: Cards;
}

const HOUR = 3_600_000;
const DEFAULT_HOURS = 48;
/** Card holds typically last about 7 days, so a collection must finish well inside that. */
const MAX_HOURS = 6 * 24;
const MIN_HOURS = 1;
/** Unpaid people get a private reminder this long before the deadline, if the collection runs at least REMIND_MIN. */
const REMIND_BEFORE = 24 * HOUR;
const REMIND_MIN = 30 * HOUR;
const MAX_OPEN = 5;
const APPROVING: ReadonlySet<Tapback> = new Set<Tapback>(["love", "like", "emphasize"]);
const HELD: ReadonlySet<PaymentRequest["status"]> = new Set<PaymentRequest["status"]>(["authorized", "capturing", "captured"]);

export type PayPageState = "pay" | "held" | "paid" | "closed" | "waiting";

export interface PayPageView {
  description: string;
  amountCents: number;
  currency: string;
  payeeName: string;
  groupName: string;
  deadline: string;
  state: PayPageState;
}

/** 24 random bytes as base64url (Web Crypto, so it runs in Node and in the browser simulator). */
export function randomToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPayments(deps: PaymentsDeps) {
  const { store, provider, gateway, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const newToken = deps.newToken ?? randomToken;
  const tzOf = (g: Group | undefined) => g?.timezone ?? deps.defaultTimezone;
  const payLink = (token: string) => `${deps.appUrl ?? ""}/pay/${token}`;

  /** Sends a payer their pay link: the text, then a card that opens the pay page (or the link in the text without cards). */
  async function sendPayLink(phone: string, text: { withLink: (link: string) => string; withCard: string }, r: PaymentRequest, c: PaymentCollection, payeeName: string) {
    if (!deps.cards) return void (await provider.send({ phone }, { text: text.withLink(payLink(r.token)) }));
    const tz = tzOf(await store.getGroup(c.groupId));
    const card = await deps.cards.make(c.groupId, {
      data: {
        source: `Pay ${payeeName}`,
        title: c.description,
        price: money(r.amountCents, c.currency),
        details: "Held until everyone's paid, then charged",
        footer: `Due ${formatLocal(c.deadlineAt, tz)}`,
        glyph: "$",
      },
      targetUrl: payLink(r.token),
    });
    await provider.send({ phone }, { text: text.withCard });
    await provider.send({ phone }, cardContent(card, null));
  }
  const connectLink = (token: string) => `${deps.appUrl ?? ""}/connect/${token}`;

  const andList = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
  const nameOf = (u: { name: string | null; phone: string } | undefined) => (u ? displayName(u) : "someone");

  function eachPhrase(requests: Array<{ amountCents: number }>, currency: string): string {
    const amounts = requests.map((r) => r.amountCents);
    const lo = Math.min(...amounts);
    const hi = Math.max(...amounts);
    return lo === hi ? `${money(lo, currency)} each` : `${money(lo, currency)} to ${money(hi, currency)} each`;
  }

  async function context(c: PaymentCollection) {
    const group = (await store.getGroup(c.groupId))!;
    const payee = (await store.getUser(c.payeeUserId))!;
    const requests = await store.paymentRequests(c.id);
    return { group, payee, requests, tz: tzOf(group) };
  }

  /** Approvals so far: explicit ones, the payee's own request, and everyone whose card is held. */
  async function approvedBy(c: PaymentCollection, requests: PaymentRequest[]): Promise<string[]> {
    const held = requests.filter((r) => HELD.has(r.status)).map((r) => r.userId);
    return [...new Set([c.payeeUserId, ...held, ...(await store.paymentApprovals(c.id))])];
  }

  /** The line asking for approval, when paying alone can't satisfy the spending rules. */
  function approvalAsk(req: ApprovalRequirement, payerIds: string[], payeeId: string, members: ChatMember[]): string {
    const covered = new Set([payeeId, ...payerIds]);
    if (req.kind === "one_of") {
      if (req.userIds.some((id) => covered.has(id))) return "";
      return ` ${nameOf(members.find((m) => m.userId === req.userIds[0]))}, reply yes or tap 👍 to approve the charge.`;
    }
    if (covered.size >= req.count) return "";
    return ` ${req.count} people need to approve: paying counts, or tap 👍 or reply “@Nod yes”.`;
  }

  // ---- starting a collection ----

  async function sendPayLinks(c: PaymentCollection, only?: PaymentRequest[]): Promise<void> {
    const { group, payee, requests, tz } = await context(c);
    for (const r of only ?? requests) {
      if (r.status !== "pending" && r.status !== "failed") continue;
      const payer = await store.getUser(r.userId);
      if (!payer) continue;
      const intro =
        `${nameOf(payee)} is collecting ${money(r.amountCents, c.currency)} from you for ${c.description} (${group.name ?? "your group"}). ` +
        `Your card is only held until everyone has paid, then charged. Pay by ${formatLocal(c.deadlineAt, tz)}`;
      await sendPayLink(payer.phone, { withLink: (link) => `${intro}: ${link}`, withCard: `${intro}.` }, r, c, nameOf(payee));
    }
  }

  async function schedule(c: PaymentCollection): Promise<void> {
    const long = c.deadlineAt.getTime() - now().getTime() >= REMIND_MIN;
    try {
      await deps.scheduler.scheduleCollection({
        collectionId: c.id,
        deadlineAt: c.deadlineAt,
        ...(long ? { reminderAt: new Date(c.deadlineAt.getTime() - REMIND_BEFORE) } : {}),
      });
    } catch (err) {
      logger.error("payments.not_scheduled", { collectionId: c.id, error: (err as Error).name });
    }
  }

  async function askForPayoutSetup(c: PaymentCollection, payee: User): Promise<void> {
    const token = await store.ensurePayoutToken(payee.id, newToken());
    const total = (await store.paymentRequests(c.id)).reduce((a, r) => a + r.amountCents, 0);
    await provider.send(
      { phone: payee.phone },
      {
        text:
          `To collect ${money(total, c.currency)} for ${c.description}, set up payouts with Stripe (a few minutes; the money goes straight to your bank, never through Nod): ` +
          connectLink(token),
      },
    );
  }

  // ---- charging ----

  /** Charges every held card once everyone has paid and the spending rules are met. Safe to call any time. */
  async function maybeCapture(collectionId: string): Promise<void> {
    const c = await store.getCollection(collectionId);
    if (!c || c.status !== "collecting") return;
    const { group, payee, requests } = await context(c);
    if (requests.some((r) => r.status === "pending" || r.status === "failed" || r.status === "cancelled")) return;
    const members = await store.groupMembers(c.groupId);
    if (!isApproved(c.approval, await approvedBy(c, requests), members.map((m) => m.userId))) return;
    if (!payee.stripeAccountId) return;

    for (const r of requests) {
      if (r.status !== "authorized" || !r.stripePaymentIntentId) continue;
      if (!(await store.transitionPaymentRequest(r.id, ["authorized"], { status: "capturing" }))) continue;
      try {
        await gateway.capture({ accountId: payee.stripeAccountId, intentId: r.stripePaymentIntentId, idempotencyKey: `capture_${r.id}_${r.attempt}` });
        await store.transitionPaymentRequest(r.id, ["capturing"], { status: "captured" });
        logger.info("payments.captured", { requestId: r.id });
        try {
          await deps.onRequestCaptured?.(c, r);
        } catch (err) {
          logger.error("payments.on_captured_failed", { requestId: r.id, error: (err as Error).name });
        }
      } catch (err) {
        if (err instanceof CardError) {
          await store.transitionPaymentRequest(r.id, ["capturing"], { status: "failed" });
          logger.warn("payments.capture_declined", { requestId: r.id, code: err.code });
          const payer = await store.getUser(r.userId);
          if (payer) {
            const declined = `Your card was declined for the ${money(r.amountCents, c.currency)} to ${nameOf(payee)} for ${c.description}.`;
            await sendPayLink(payer.phone, { withLink: (link) => `${declined} Please pay again here: ${link}`, withCard: `${declined} Please pay again.` }, r, c, nameOf(payee));
          }
          await provider.send({ phone: payee.phone }, { text: `${nameOf(payer)}'s card was declined for ${c.description}. I've asked them privately to pay again.` });
        } else {
          // Unknown outcome (a timeout, Stripe down): put it back to try again; the idempotency key stops a double charge.
          await store.transitionPaymentRequest(r.id, ["capturing"], { status: "authorized" });
          logger.error("payments.capture_failed", { requestId: r.id, error: (err as Error).name });
        }
      }
    }

    const after = await store.paymentRequests(c.id);
    if (!after.every((r) => r.status === "captured")) return;
    if (!(await store.transitionCollection(c.id, ["collecting"], { status: "captured" }))) return;
    const total = after.reduce((a, r) => a + r.amountCents, 0);
    await provider.send(
      { groupId: group.providerGroupId },
      { text: `Everyone's paid for ${c.description}: ${money(total, c.currency)} charged and paid to ${nameOf(payee)}.` },
    );
    logger.info("payments.collection_captured", { collectionId: c.id });
  }

  /** Releases every hold that wasn't charged. Returns how many requests had been charged. */
  async function releaseHolds(c: PaymentCollection, payee: User, requests: PaymentRequest[]): Promise<number> {
    let charged = 0;
    for (const r of requests) {
      if (r.status === "captured") {
        charged++;
        continue;
      }
      if (!(await store.transitionPaymentRequest(r.id, ["pending", "authorized", "failed"], { status: "cancelled" }))) continue;
      if (r.stripePaymentIntentId && payee.stripeAccountId) {
        try {
          await gateway.cancel({ accountId: payee.stripeAccountId, intentId: r.stripePaymentIntentId, idempotencyKey: `cancel_${r.id}_${r.attempt}` });
        } catch (err) {
          logger.error("payments.release_failed", { requestId: r.id, error: (err as Error).name });
        }
      }
    }
    return charged;
  }

  // ---- Stripe updates (webhooks, and the pay page on return) ----

  /** Re-reads a PaymentIntent and applies its state. Safe to repeat. */
  async function syncIntent(intentId: string): Promise<void> {
    const r = await store.paymentRequestByIntent(intentId);
    if (!r) return;
    const c = (await store.getCollection(r.collectionId))!;
    const payee = (await store.getUser(c.payeeUserId))!;
    if (!payee.stripeAccountId) return;
    const intent = await gateway.getIntent({ accountId: payee.stripeAccountId, intentId });

    if (intent.status === "requires_capture" && intent.amountCapturable >= r.amountCents) {
      if (c.status !== "collecting") {
        // Paid after the collection closed: release it straight away.
        await gateway.cancel({ accountId: payee.stripeAccountId, intentId, idempotencyKey: `cancel_${r.id}_${r.attempt}` }).catch(() => {});
        return;
      }
      if (await store.transitionPaymentRequest(r.id, ["pending", "failed"], { status: "authorized" })) {
        logger.info("payments.authorized", { requestId: r.id });
        await maybeCapture(c.id);
      }
    } else if (intent.status === "succeeded") {
      await store.transitionPaymentRequest(r.id, ["authorized", "capturing"], { status: "captured" });
    } else if (intent.status === "canceled" && c.status === "collecting") {
      // The hold lapsed or was released outside Nod: ask them to pay again with a fresh hold.
      const wasHeld = r.status === "authorized";
      if (await store.transitionPaymentRequest(r.id, ["authorized", "pending", "failed"], { status: "pending", stripePaymentIntentId: null, attempt: r.attempt + 1 })) {
        const payer = await store.getUser(r.userId);
        if (wasHeld && payer) {
          const lapsed = `The hold on your card for ${c.description} lapsed, so nothing was charged.`;
          await sendPayLink(payer.phone, { withLink: (link) => `${lapsed} Please pay again here: ${link}`, withCard: `${lapsed} Please pay again.` }, r, c, nameOf(await store.getUser(c.payeeUserId)));
        }
      }
    }
  }

  /** Re-reads a payee's Stripe account; once it can take payments, their waiting collections start. */
  async function syncAccount(accountId: string): Promise<void> {
    const ready = await gateway.accountReady(accountId);
    const user = await store.setStripeAccountReady(accountId, ready);
    if (!user || !ready) return;
    for (const c of await store.collectionsAwaitingPayee(user.id)) {
      if (!(await store.transitionCollection(c.id, ["setup"], { status: "collecting" }))) continue;
      const started = (await store.getCollection(c.id))!;
      await sendPayLinks(started);
      const { group } = await context(started);
      await provider.send({ groupId: group.providerGroupId }, { text: `${nameOf(user)} is set up for payouts, so I've sent everyone their pay link for ${c.description}.` });
      logger.info("payments.collection_started", { collectionId: c.id });
    }
  }

  // ---- web pages ----

  async function payPage(token: string): Promise<PayPageView | null> {
    let r = await store.paymentRequestByToken(token);
    if (!r) return null;
    if (r.stripePaymentIntentId && (r.status === "pending" || r.status === "failed")) {
      // Back from Stripe before the webhook arrived: check the hold directly.
      await syncIntent(r.stripePaymentIntentId).catch((err) => logger.warn("payments.sync_failed", { error: (err as Error).name }));
      r = (await store.getPaymentRequest(r.id))!;
    }
    const c = (await store.getCollection(r.collectionId))!;
    const { group, payee, tz } = await context(c);
    const state: PayPageState =
      r.status === "captured"
        ? "paid"
        : r.status === "authorized" || r.status === "capturing"
          ? "held"
          : c.status === "setup"
            ? "waiting"
            : c.status !== "collecting" || r.status === "cancelled"
              ? "closed"
              : "pay";
    return {
      description: c.description,
      amountCents: r.amountCents,
      currency: c.currency,
      payeeName: nameOf(payee),
      groupName: group.name ?? "your group",
      deadline: formatLocal(c.deadlineAt, tz),
      state,
    };
  }

  /** Creates (or reuses) the card hold for a pay link, for Stripe.js on the pay page. */
  async function startPayment(token: string): Promise<{ clientSecret: string; publishableKey: string; accountId: string } | { state: PayPageState }> {
    let r = await store.paymentRequestByToken(token);
    if (!r) throw new ToolError("That pay link isn't valid.");
    const c = (await store.getCollection(r.collectionId))!;
    const payee = (await store.getUser(c.payeeUserId))!;
    if (c.status !== "collecting" || !payee.stripeAccountId || !payee.stripeAccountReady) return { state: c.status === "setup" ? "waiting" : "closed" };
    if (r.status !== "pending" && r.status !== "failed") return { state: r.status === "captured" ? "paid" : r.status === "cancelled" ? "closed" : "held" };
    const accountId = payee.stripeAccountId;

    if (r.stripePaymentIntentId) {
      const intent = await gateway.getIntent({ accountId, intentId: r.stripePaymentIntentId });
      if (intent.status === "requires_capture" || intent.status === "succeeded") {
        await syncIntent(intent.id);
        return { state: "held" };
      }
      if (intent.status !== "canceled") return { clientSecret: intent.clientSecret, publishableKey: gateway.publishableKey, accountId };
      // The old hold is gone; start a fresh one.
      await store.transitionPaymentRequest(r.id, ["pending", "failed"], { stripePaymentIntentId: null, attempt: r.attempt + 1 });
      r = (await store.getPaymentRequest(r.id))!;
    }
    const intent = await gateway.createHold({
      accountId,
      amountCents: r.amountCents,
      currency: c.currency,
      description: `${c.description} (Nod)`,
      metadata: { requestId: r.id, collectionId: c.id },
      idempotencyKey: `hold_${r.id}_${r.attempt}`,
    });
    await store.setPaymentIntent(r.id, intent.id);
    return { clientSecret: intent.clientSecret, publishableKey: gateway.publishableKey, accountId };
  }

  /** Where a payee's payout setup link leads: Stripe's onboarding, or nowhere if they're done. */
  async function payoutSetup(token: string, opts: { returning?: boolean } = {}): Promise<{ redirect: string } | { ready: true } | null> {
    const user = await store.userByPayoutToken(token);
    if (!user) return null;
    let accountId = user.stripeAccountId;
    if (accountId && (opts.returning || user.stripeAccountReady)) {
      await syncAccount(accountId);
      if ((await store.getUser(user.id))?.stripeAccountReady) return { ready: true };
    }
    if (!accountId) {
      ({ accountId } = await gateway.createAccount({ phone: user.phone, name: user.name }));
      await store.setStripeAccount(user.id, accountId);
    }
    const { url } = await gateway.onboardingLink({ accountId, returnUrl: `${connectLink(token)}?done=1`, refreshUrl: connectLink(token) });
    return { redirect: url };
  }

  // ---- scheduled jobs ----

  async function runJob(job: PaymentJob): Promise<void> {
    const c = await store.getCollection(job.collectionId);
    if (!c) return;
    if (job.type === "collection_reminder") {
      if (c.status !== "collecting" || !(await store.claimCollectionReminder(c.id))) return;
      const { payee, requests, tz } = await context(c);
      for (const r of requests) {
        if (r.status !== "pending" && r.status !== "failed") continue;
        const payer = await store.getUser(r.userId);
        if (!payer) continue;
        const reminder =
          `Reminder: ${money(r.amountCents, c.currency)} to ${nameOf(payee)} for ${c.description}, due ${formatLocal(c.deadlineAt, tz)}. ` +
          `Your card is only held until everyone has paid`;
        await sendPayLink(payer.phone, { withLink: (link) => `${reminder}: ${link}`, withCard: `${reminder}.` }, r, c, nameOf(payee));
      }
      logger.info("payments.reminded", { collectionId: c.id });
      return;
    }
    if (c.deadlineAt.toISOString() !== job.deadlineAt) return;
    const { group, payee, requests } = await context(c);
    if (c.status === "setup") {
      if (!(await store.transitionCollection(c.id, ["setup"], { status: "expired" }))) return;
      await provider.send({ groupId: group.providerGroupId }, { text: `Time's up for ${c.description}: payouts weren't set up in time, so nobody was charged.` });
      return;
    }
    if (c.status !== "collecting") return;
    if (!(await store.transitionCollection(c.id, ["collecting"], { status: "expired" }))) return;
    const paid = requests.filter((r) => HELD.has(r.status)).length;
    const unpaid = requests.filter((r) => !HELD.has(r.status));
    const charged = await releaseHolds(c, payee, requests);
    const n = requests.length;
    await provider.send(
      { groupId: group.providerGroupId },
      {
        text: charged
          ? `Time's up for ${c.description}: ${charged} of ${n} payments went through and the rest were released. I've told ${nameOf(payee)} privately who's left.`
          : `Time's up for ${c.description}: ${paid} of ${n} paid, so nobody was charged and the holds are released.`,
      },
    );
    const names = await Promise.all(unpaid.map(async (r) => nameOf(await store.getUser(r.userId))));
    if (names.length) await provider.send({ phone: payee.phone }, { text: `Not paid for ${c.description}: ${andList(names)}.` });
    logger.info("payments.collection_expired", { collectionId: c.id, paid, charged });
  }

  // ---- approvals from tapbacks ----

  async function tapback(groupId: string, userId: string, messageId: string, reaction: Tapback, removed: boolean): Promise<void> {
    const c = await store.collectionByMessage(groupId, messageId);
    if (!c || (c.status !== "collecting" && c.status !== "setup") || !APPROVING.has(reaction)) return;
    if (!(await store.groupMembers(groupId)).some((m) => m.userId === userId)) return;
    if (removed) return store.removePaymentApproval(c.id, userId);
    await store.addPaymentApproval(c.id, userId);
    await maybeCapture(c.id);
  }

  async function onReaction(call: { event: InboundReaction; groupId: string; userId: string }): Promise<void> {
    await tapback(call.groupId, call.userId, call.event.targetMessageId, call.event.reaction, call.event.removed);
  }

  async function captureTapback(call: MessageCall): Promise<void> {
    if (!call.groupId) return;
    const parsed = parseTapbackText(call.event.text);
    if (!parsed) return;
    const messageId = await store.findMessageIdByText(call.groupId, parsed.quoted);
    if (messageId) await tapback(call.groupId, call.senderUserId, messageId, parsed.reaction, parsed.removed);
  }

  /**
   * Opens a collection: works out who must approve, saves it, posts the request (unless the caller posts its own),
   * sends pay links (or asks the payee to set up payouts first) and schedules the reminder and deadline.
   */
  async function startCollection(args: {
    group: Group;
    payeeUserId: string;
    description: string;
    shares: Array<{ userId: string; amountCents: number }>;
    deadlineAt: Date;
    members: ChatMember[];
    purpose: "request" | "settle_up";
    /** False when the caller posts its own group message (settle-up). */
    announce?: boolean;
  }): Promise<PaymentCollection> {
    const { group, shares, deadlineAt, members, description } = args;
    const tz = tzOf(group);
    const payee = (await store.getUser(args.payeeUserId))!;
    const payerIds = shares.map((s) => s.userId);
    // Settling up: each person only ever pays their own debt, and paying is their approval, so no one else signs off.
    const approval: ApprovalRequirement =
      args.purpose === "settle_up"
        ? { kind: "one_of", userIds: [payee.id] }
        : approvalRequirement({
            rules: readSpendRules(group.spendRules),
            depositCents: Math.max(...shares.map((s) => s.amountCents)),
            partySize: 1,
            organizerUserId: group.organizerUserId,
            addedByUserId: group.addedByUserId,
            requesterUserId: payee.id,
            memberIds: members.map((m) => m.userId),
          });
    const ready = payee.stripeAccountReady && !!payee.stripeAccountId;
    const { collection } = await store.createCollection({
      groupId: group.id,
      decisionId: null,
      payeeUserId: payee.id,
      description,
      currency: "USD",
      status: ready ? "collecting" : "setup",
      deadlineAt,
      approval,
      purpose: args.purpose,
      requests: shares.map((s) => ({ ...s, token: newToken() })),
    });

    if (args.announce !== false) {
      const names = andList(payerIds.map((id) => nameOf(members.find((m) => m.userId === id))));
      const each = eachPhrase(shares, "USD");
      const ask = approvalAsk(approval, payerIds, payee.id, members);
      const text = ready
        ? `Collecting ${each} from ${names} for ${description}, paid to ${nameOf(payee)}. Cards are only held for now and charged once everyone has paid, by ${formatLocal(deadlineAt, tz)}. I've sent each of you a private link.${ask}`
        : `Collecting ${each} from ${names} for ${description}, paid to ${nameOf(payee)}. ${nameOf(payee)} needs to set up payouts first (I sent a private link), then pay links go out. Cards are charged only once everyone has paid.${ask}`;
      const sent = await provider.send({ groupId: group.providerGroupId }, { text });
      await store.updateCollection(collection.id, { messageId: sent.messageId });
    }

    if (ready) await sendPayLinks(collection);
    else await askForPayoutSetup(collection, payee);
    await schedule(collection);
    logger.info("payments.requested", { collectionId: collection.id, payers: shares.length, ready, purpose: args.purpose });
    return (await store.getCollection(collection.id))!;
  }

  // ---- tools ----

  async function openCollection(ctx: ToolContext, id?: string): Promise<PaymentCollection> {
    if (ctx.chat.kind !== "group") throw new ToolError("Use this in the group chat.");
    const open = (await store.listCollections(ctx.chat.groupId)).filter((c) => c.status === "setup" || c.status === "collecting");
    const c = id ? open.find((x) => x.id === id) : open.length === 1 ? open[0] : undefined;
    if (!c) throw new ToolError(open.length ? "Which collection? Pass its collection_id." : "There's no open collection in this group.");
    return c;
  }

  const requestPayments = defineTool<{
    description: string;
    amount_per_person_cents?: number;
    total_cents?: number;
    requester_shares?: boolean;
    payers?: string[];
    deadline_local?: string;
    hours?: number;
  }>({
    name: "request_payments",
    description:
      "Collect money from group members for something the caller paid for or is paying for (a rental, a deposit, dinner). The money goes " +
      "to the caller only. Give amount_per_person_cents, or total_cents to split evenly (requester_shares: whether the caller pays a share " +
      "too; default true). payers: member names; default everyone else in the group. Each payer gets a private pay link; cards are held " +
      "and charged only once everyone has paid. Deadline: deadline_local (this chat's timezone) or hours; default 48 hours, at most 6 days. " +
      "Confirm the amount and who pays if unclear before calling. Nod posts the request itself; after it succeeds, end your turn without writing anything.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "What it's for, short: 'Casa Azul', 'Saturday dinner deposit'." },
        amount_per_person_cents: { type: "integer", minimum: 1 },
        total_cents: { type: "integer", minimum: 1 },
        requester_shares: { type: "boolean" },
        payers: { type: "array", items: { type: "string" } },
        deadline_local: { type: "string" },
        hours: { type: "number" },
      },
      required: ["description"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (ctx.chat.kind !== "group") throw new ToolError("Collect money from the group chat.");
      if ((input.amount_per_person_cents === undefined) === (input.total_cents === undefined)) {
        throw new ToolError("Give either amount_per_person_cents or total_cents.");
      }
      const description = input.description.trim().slice(0, 80);
      if (!description) throw new ToolError("Say what the money is for.");
      const group = (await store.getGroup(ctx.chat.groupId))!;
      const open = (await store.listCollections(group.id)).filter((c) => c.status === "setup" || c.status === "collecting");
      if (open.length >= MAX_OPEN) throw new ToolError(`This group already has ${open.length} open collections. Close one first.`);

      const payerIds = input.payers?.length
        ? [...new Set(input.payers.map((n) => resolveMember(ctx, n).userId))].filter((id) => id !== ctx.caller.userId)
        : ctx.members.map((m) => m.userId).filter((id) => id !== ctx.caller.userId);
      let shares;
      try {
        shares =
          input.amount_per_person_cents !== undefined
            ? splitShares({ perPersonCents: input.amount_per_person_cents, payers: payerIds })
            : splitShares({ totalCents: input.total_cents!, payers: payerIds, requesterShares: input.requester_shares ?? true });
      } catch (err) {
        if (err instanceof SplitError) throw new ToolError(err.message);
        throw err;
      }

      const tz = tzOf(group);
      let deadlineAt: Date;
      if (input.deadline_local) {
        const d = localDateTimeToUtc(input.deadline_local, tz);
        if (!d) throw new ToolError("Give the deadline as a local date and time like 2026-10-02T18:00.");
        deadlineAt = d;
      } else {
        deadlineAt = new Date(now().getTime() + (input.hours ?? DEFAULT_HOURS) * HOUR);
      }
      const span = (deadlineAt.getTime() - now().getTime()) / HOUR;
      if (span < MIN_HOURS) throw new ToolError("Give people at least an hour to pay.");
      if (span > MAX_HOURS) throw new ToolError("Collections can run at most 6 days, because card holds expire after about a week.");

      await startCollection({ group, payeeUserId: ctx.caller.userId, description, shares, deadlineAt, members: ctx.members, purpose: "request" });
      return "The request is posted and the private links are sent. End your turn without writing anything.";
    },
  });

  const approvePayments = defineTool<{ collection_id?: string }>({
    name: "approve_payments",
    description:
      "Record the caller's approval of a collection's charge, when they say yes to it ('@Nod yes', 'approved'). Only needed when the " +
      "request asked for approval. Cards are charged once everyone has paid and approvals are in.",
    inputSchema: { type: "object", properties: { collection_id: { type: "string" } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      const c = await openCollection(ctx, input.collection_id);
      await store.addPaymentApproval(c.id, ctx.caller.userId);
      await maybeCapture(c.id);
      const after = (await store.getCollection(c.id))!;
      return after.status === "captured"
        ? "Approved; everyone had paid, so the cards were charged and the group was told. End your turn without writing anything."
        : `Recorded ${ctx.caller.name}'s approval. Cards are charged once everyone has paid.`;
    },
  });

  const cancelPayments = defineTool<{ collection_id?: string }>({
    name: "cancel_payments",
    description: "Call off a collection and release every card hold. Only the person collecting the money can. Then confirm in a few words.",
    inputSchema: { type: "object", properties: { collection_id: { type: "string" } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      const c = await openCollection(ctx, input.collection_id);
      if (c.payeeUserId !== ctx.caller.userId) throw new ToolError("Only the person collecting the money can cancel it.");
      const { payee, requests } = await context(c);
      if (requests.some((r) => r.status === "captured" || r.status === "capturing")) {
        throw new ToolError("Some payments already went through, and Nod can't refund them yet.");
      }
      if (!(await store.transitionCollection(c.id, ["setup", "collecting"], { status: "cancelled" }))) throw new ToolError("That collection already closed.");
      await releaseHolds(c, payee, requests);
      logger.info("payments.cancelled", { collectionId: c.id });
      return `Cancelled the ${c.description} collection. Nobody was charged and every hold is released.`;
    },
  });

  const resendPayLink = defineTool<{ collection_id?: string }>({
    name: "resend_pay_link",
    description: "Privately re-send the caller their pay link(s) for open collections they haven't paid, when they ask for it. Works from the group or a private chat.",
    inputSchema: { type: "object", properties: { collection_id: { type: "string" } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      const open = (await store.openCollectionsForUser(ctx.caller.userId)).filter((c) => c.status === "collecting" && (!input.collection_id || c.id === input.collection_id));
      let sent = 0;
      for (const c of open) {
        const mine = (await store.paymentRequests(c.id)).filter((r) => r.userId === ctx.caller.userId);
        if (mine.some((r) => r.status === "pending" || r.status === "failed")) {
          await sendPayLinks(c, mine);
          sent++;
        }
      }
      if (!sent) throw new ToolError("They have nothing left to pay.");
      return `Sent ${ctx.caller.name} their pay link${sent > 1 ? "s" : ""} privately. Tell them in a few words.`;
    },
  });

  // ---- context ----

  async function describe(c: PaymentCollection, viewerId?: string): Promise<string> {
    const { payee, requests, tz } = await context(c);
    const members = await store.groupMembers(c.groupId);
    const paid = requests.filter((r) => HELD.has(r.status)).length;
    const head = `[collection ${c.id}] ${c.description} · ${eachPhrase(requests, c.currency)} from ${requests.length} · paid to ${nameOf(payee)}`;
    const state =
      c.status === "setup"
        ? `waiting on ${nameOf(payee)}'s payout setup`
        : `${paid} of ${requests.length} paid (cards held, charged once everyone has paid), closes ${formatLocal(c.deadlineAt, tz)}`;
    const approved = isApproved(c.approval, await approvedBy(c, requests), members.map((m) => m.userId));
    const lines = [`${head} · ${state}${approved ? "" : " · still needs approval"}`];
    if (viewerId === c.payeeUserId) {
      const unpaid = await Promise.all(requests.filter((r) => !HELD.has(r.status)).map(async (r) => nameOf(await store.getUser(r.userId))));
      if (unpaid.length) lines.push(`Not paid yet: ${andList(unpaid)}.`);
    } else if (viewerId) {
      const mine = requests.find((r) => r.userId === viewerId);
      if (mine) lines.push(`They owe ${money(mine.amountCents, c.currency)}: ${HELD.has(mine.status) ? "paid (card held or charged)" : "not paid yet (resend_pay_link sends their link)"}.`);
    }
    return lines.join("\n");
  }

  const section: ContextSection = async (call) => {
    if (call.groupId) {
      const list = (await store.listCollections(call.groupId)).filter((c) => c.status === "setup" || c.status === "collecting").slice(0, 5);
      if (!list.length) return null;
      const blocks = await Promise.all(list.map((c) => describe(c)));
      return {
        title: "payments",
        body: `${blocks.join("\n")}\nNever say in the group who hasn't paid or how much one person owes; tell that person privately.`,
      };
    }
    const mine = (await store.openCollectionsForUser(call.senderUserId)).slice(0, 5);
    if (!mine.length) return null;
    return { title: "payments", body: (await Promise.all(mine.map((c) => describe(c, call.senderUserId)))).join("\n\n") };
  };

  const tools: NodTool<any>[] = [requestPayments, approvePayments, cancelPayments, resendPayLink];
  return { tools, section, onReaction, captureTapback, runJob, syncIntent, syncAccount, payPage, startPayment, payoutSetup, maybeCapture, startCollection };
}

export type Payments = ReturnType<typeof createPayments>;
