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
import { defaultTools } from "./agent/tools/index";
import type { NodTool } from "./agent/tools";
import { createRentals, noListingFetcher, type ListingFetcher } from "./rentals/rentals";
import { noSearcher, type Searcher } from "./search/picks";
import { createWebSearch } from "./search/search";

export interface NodDeps {
  store: Store;
  provider: MessagingProvider;
  classify: Classifier;
  /** Checks follow-up answers to Nod's questions (createClaudeAnswerClassifier in production). Omit to turn follow-ups off. */
  classifyAnswer?: AnswerClassifier;
  logger: Logger;
  /** Onboarding media, plus the public app URL used for links such as search results pages. */
  config: OnboardingConfig & { appUrl?: string };
  /** Handles calls onboarding doesn't (normally Claude orchestration, see makeResponder). */
  respond?: (call: AddressedCall) => Promise<void>;
  /** Builds the responder from Nod's environment, including every feature's tools and context sections: `(env) => createResponder(env)`. */
  makeResponder?: (env: ResponderEnv) => (call: AddressedCall) => Promise<void>;
  /** Reads listing pages for rental cards: `webListingFetcher` in production, sample pages in the web simulator. */
  fetchListing?: ListingFetcher;
  /** Runs web searches: `createClaudeSearcher()` in production, sample results in the web simulator. */
  searcher?: Searcher;
  now?: () => Date;
}

export interface ResponderEnv {
  store: Store;
  provider: MessagingProvider;
  logger: Logger;
  tools: NodTool<any>[];
  sections: ContextSection[];
  now?: () => Date;
}

export function createNod(deps: NodDeps) {
  const provider = deps.provider instanceof RecordingProvider ? deps.provider : new RecordingProvider(deps.provider, deps.store);
  const onboarding = createOnboarding({ store: deps.store, provider, config: deps.config, logger: deps.logger, now: deps.now });
  const rentals = createRentals({ store: deps.store, fetchListing: deps.fetchListing ?? noListingFetcher, logger: deps.logger, now: deps.now });
  const webSearch = createWebSearch({
    store: deps.store,
    searcher: deps.searcher ?? noSearcher,
    logger: deps.logger,
    appUrl: deps.config.appUrl,
    now: deps.now,
  });
  const env: ResponderEnv = {
    store: deps.store,
    provider,
    logger: deps.logger,
    tools: [...defaultTools, ...rentals.tools, ...webSearch.tools],
    sections: [rentals.section, webSearch.section],
    now: deps.now,
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
    onMessage: rentals.captureLinks,
    onAddressed: async (call) => {
      if (await onboarding.handleAddressed(call)) return;
      await respond?.(call);
    },
  });
  return {
    handle: (event: InboundEvent, opts?: HandleOptions) => pipeline.handle(event, opts),
    pipeline,
    provider,
    onboarding,
  };
}

export type Nod = ReturnType<typeof createNod>;
