// Nod, assembled: inbound pipeline + onboarding, over any MessagingProvider and Store.
// Production (src/server/container.ts), the simulator CLI and the web page all use this.

import type { Store } from "./db/store";
import type { Classifier } from "./detection/addressed";
import { createInboundPipeline, type AddressedCall, type HandleOptions } from "./inbound/pipeline";
import { RecordingProvider } from "./inbound/recording-provider";
import type { Logger } from "./lib/log";
import type { InboundEvent, MessagingProvider } from "./messaging/types";
import { createOnboarding, type OnboardingConfig } from "./onboarding/onboarding";

export interface NodDeps {
  store: Store;
  provider: MessagingProvider;
  classify: Classifier;
  logger: Logger;
  config: OnboardingConfig;
  /** Handles calls onboarding doesn't (normally Claude orchestration, see makeResponder). */
  respond?: (call: AddressedCall) => Promise<void>;
  /** Builds the responder once the recording provider exists, e.g. `(env) => createResponder({ ...env, tools })`. */
  makeResponder?: (env: { store: Store; provider: MessagingProvider; logger: Logger }) => (call: AddressedCall) => Promise<void>;
  now?: () => Date;
}

export function createNod(deps: NodDeps) {
  const provider = deps.provider instanceof RecordingProvider ? deps.provider : new RecordingProvider(deps.provider, deps.store);
  const onboarding = createOnboarding({ store: deps.store, provider, config: deps.config, logger: deps.logger, now: deps.now });
  const respond = deps.respond ?? deps.makeResponder?.({ store: deps.store, provider, logger: deps.logger });
  const pipeline = createInboundPipeline({
    store: deps.store,
    selfPhone: provider.selfPhone,
    classify: deps.classify,
    logger: deps.logger,
    now: deps.now,
    onJoined: onboarding.onJoined,
    onLeft: onboarding.onLeft,
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
