// Nod, assembled: inbound pipeline + onboarding, over any MessagingProvider and Store.
// Production (src/server/container.ts), the simulator CLI and the web page all use this.

import type { Store } from "./db/store";
import type { AnswerClassifier, Classifier } from "./detection/addressed";
import { createInboundPipeline, type AddressedCall, type HandleOptions } from "./inbound/pipeline";
import { RecordingProvider } from "./inbound/recording-provider";
import type { Logger } from "./lib/log";
import type { InboundEvent, MessagingProvider } from "./messaging/types";
import { createOnboarding, type OnboardingConfig } from "./onboarding/onboarding";
import type { ContextSection } from "./agent/context";
import type { RespondOptions } from "./agent/responder";
import { defaultTools } from "./agent/tools/index";
import type { NodTool } from "./agent/tools";
import { createRentals, noListingFetcher, type ListingFetcher } from "./rentals/rentals";
import { noSearcher, type Searcher } from "./search/picks";
import { createWebSearch } from "./search/search";
import { noScheduler, type NodJob, type Scheduler } from "./jobs/scheduler";
import { createVoting } from "./voting/voting";
import { createBookings } from "./booking/booking";
import type { BookingPartner } from "./booking/partners";
import { noGateway, type PaymentGateway } from "./payments/gateway";
import { createPayments, type Payments } from "./payments/payments";
import { noReceiptReader, type ReceiptReader } from "./tab/receipts";
import { createTab } from "./tab/tab";
import { createDatePolls } from "./dates/polls";
import { createCalendar } from "./calendar/calendar";
import { createNotes } from "./notes/notes";
import { createInvites } from "./invites/invites";
import { createPrivacy } from "./privacy/privacy";
import type { RandomBytes } from "./invites/codes";

export interface NodDeps {
  store: Store;
  provider: MessagingProvider;
  classify: Classifier;
  /** Checks follow-up answers to Nod's questions (createClaudeAnswerClassifier in production). Omit to turn follow-ups off. */
  classifyAnswer?: AnswerClassifier;
  logger: Logger;
  /** Onboarding media, plus the public app URL used for links such as search results pages. */
  config: OnboardingConfig & { appUrl?: string; timezone?: string };
  /** Handles calls onboarding doesn't (normally Claude orchestration, see makeResponder). */
  respond?: (call: AddressedCall, opts?: RespondOptions) => Promise<void>;
  /** Builds the responder from Nod's environment, including every feature's tools and context sections: `(env) => createResponder(env)`. */
  makeResponder?: (env: ResponderEnv) => (call: AddressedCall, opts?: RespondOptions) => Promise<void>;
  /** Reads listing pages for rental cards: `webListingFetcher` in production, sample pages in the web simulator. */
  fetchListing?: ListingFetcher;
  /** Runs web searches: `createClaudeSearcher()` in production, sample results in the web simulator. */
  searcher?: Searcher;
  /** Vote nudges, deadlines and booking reminders: Inngest in production, MemoryScheduler in tests and simulators. */
  scheduler?: Scheduler;
  /** Booking partners Nod books through itself (the sample partner in simulators). None: every booking is a link hand-off. */
  bookingPartners?: BookingPartner[];
  /** Card payments: Stripe in production, FakeGateway in tests and simulators. Omit to leave payments out. */
  paymentGateway?: PaymentGateway;
  /** Reads receipt photos: createClaudeReceiptReader() in production, the sample reader in the web simulator. */
  receiptReader?: ReceiptReader;
  /** Randomness for invite codes (tests only). */
  random?: RandomBytes;
  now?: () => Date;
}

export interface ResponderEnv {
  store: Store;
  provider: MessagingProvider;
  logger: Logger;
  tools: NodTool<any>[];
  sections: ContextSection[];
  now?: () => Date;
  timezone: string;
}

export function createNod(deps: NodDeps) {
  const provider = deps.provider instanceof RecordingProvider ? deps.provider : new RecordingProvider(deps.provider, deps.store);
  const onboarding = createOnboarding({ store: deps.store, provider, config: deps.config, logger: deps.logger, now: deps.now });
  const invites = createInvites({ store: deps.store, provider, onboarding, logger: deps.logger, appUrl: deps.config.appUrl, now: deps.now, random: deps.random });
  const privacy = createPrivacy({ store: deps.store, logger: deps.logger, appUrl: deps.config.appUrl });
  const rentals = createRentals({ store: deps.store, fetchListing: deps.fetchListing ?? noListingFetcher, logger: deps.logger, now: deps.now });
  const webSearch = createWebSearch({
    store: deps.store,
    searcher: deps.searcher ?? noSearcher,
    logger: deps.logger,
    appUrl: deps.config.appUrl,
    now: deps.now,
  });
  const timezone = deps.config.timezone ?? "America/New_York";
  const voting = createVoting({
    store: deps.store,
    provider,
    scheduler: deps.scheduler ?? noScheduler,
    logger: deps.logger,
    defaultTimezone: timezone,
    now: deps.now,
  });
  const notes = createNotes({ store: deps.store, logger: deps.logger });
  const calendar = createCalendar({
    store: deps.store,
    provider,
    scheduler: deps.scheduler ?? noScheduler,
    logger: deps.logger,
    defaultTimezone: timezone,
    appUrl: deps.config.appUrl,
    now: deps.now,
  });
  const bookings = createBookings({
    store: deps.store,
    logger: deps.logger,
    onBookingCancelled: calendar.cancelForBooking,
    provider,
    scheduler: deps.scheduler ?? noScheduler,
    partners: deps.bookingPartners,
    defaultTimezone: timezone,
    appUrl: deps.config.appUrl,
    now: deps.now,
  });
  const datePolls = createDatePolls({
    store: deps.store,
    provider,
    scheduler: deps.scheduler ?? noScheduler,
    logger: deps.logger,
    defaultTimezone: timezone,
    now: deps.now,
  });
  let payments: Payments | null = null;
  const tab = createTab({
    store: deps.store,
    provider,
    logger: deps.logger,
    receiptReader: deps.receiptReader ?? noReceiptReader,
    payments: () => payments,
    now: deps.now,
  });
  payments = deps.paymentGateway
    ? createPayments({
        store: deps.store,
        provider,
        gateway: deps.paymentGateway ?? noGateway,
        scheduler: deps.scheduler ?? noScheduler,
        logger: deps.logger,
        defaultTimezone: timezone,
        appUrl: deps.config.appUrl,
        now: deps.now,
        onRequestCaptured: tab.onRequestCaptured,
      })
    : null;
  const env: ResponderEnv = {
    store: deps.store,
    provider,
    logger: deps.logger,
    tools: [...defaultTools, ...rentals.tools, ...webSearch.tools, ...voting.tools, ...datePolls.tools, ...bookings.tools, ...calendar.tools, ...notes.tools, ...invites.tools, ...privacy.tools, ...(payments?.tools ?? []), ...tab.tools],
    sections: [notes.section, rentals.section, webSearch.section, voting.section, datePolls.section, bookings.section, calendar.section, ...(payments ? [payments.section] : []), tab.section],
    now: deps.now,
    timezone,
  };
  const respond = deps.respond ?? deps.makeResponder?.(env);
  const pipeline = createInboundPipeline({
    store: deps.store,
    selfPhone: provider.selfPhone,
    classify: deps.classify,
    classifyAnswer: deps.classifyAnswer,
    logger: deps.logger,
    now: deps.now,
    onJoined: onboarding.onJoined,
    onLeft: onboarding.onLeft,
    onMessage: async (call) => {
      await rentals.captureLinks(call);
      await voting.captureVote(call);
      await datePolls.captureAnswer(call);
      await bookings.captureTapback(call);
      await payments?.captureTapback(call);
    },
    onReaction: async (call) => {
      await voting.onReaction(call);
      await bookings.onReaction(call);
      await datePolls.onReaction(call);
      await payments?.onReaction(call);
    },
    onAddressed: (call) => handleAddressed(call),
  });

  /** Answers one call: access and onboarding first, then Claude. The reply job calls this with `final: false` until its last attempt. */
  async function handleAddressed(call: AddressedCall, opts: RespondOptions = {}): Promise<void> {
    if (await invites.handlePrivate(call)) return;
    if (await onboarding.handleAddressed(call)) return;
    await respond?.(call, opts);
  }
  return {
    handle: (event: InboundEvent, opts?: HandleOptions) => pipeline.handle(event, opts),
    /** Runs a queued call (the `reply` Inngest job). */
    handleAddressed,
    pipeline,
    provider,
    onboarding,
    voting,
    /** Invites: the daily post-trip sweep and the admin scripts call into this. */
    invites,
    /** Per-member settings pages (/group/[id]/settings). */
    privacy,
    /** Runs a scheduled job (vote nudge or deadline, booking reminder). */
    /** Payments: webhooks, pay pages and payout setup call into this. Null when no gateway is configured. */
    payments,
    runJob: async (job: NodJob): Promise<void> => {
      if (job.type === "cancel_reminder") return bookings.runJob(job);
      if (job.type === "collection_reminder" || job.type === "collection_deadline") return payments?.runJob(job);
      if (job.type === "event_reminder") return calendar.runJob(job);
      // Votes and date polls share the nudge and deadline jobs; route by the decision's kind.
      const decision = await deps.store.getDecision(job.decisionId);
      return decision?.kind === "date_poll" ? datePolls.runJob(job) : voting.runJob(job);
    },
  };
}

export type Nod = ReturnType<typeof createNod>;
