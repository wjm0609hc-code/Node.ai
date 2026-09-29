// Nod, assembled: inbound pipeline + onboarding, over any MessagingProvider and Store.
// Production (src/server/container.ts), the simulator CLI and the web page all use this.

import type { Store } from "./db/store";
import type { Classifier } from "./detection/addressed";
import { createInboundPipeline, type AddressedCall } from "./inbound/pipeline";
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
  /** Phase 1 step 4: Claude orchestration for calls onboarding doesn't handle. */
  respond?: (call: AddressedCall) => Promise<void>;
  now?: () => Date;
}

export function createNod(deps: NodDeps) {
  const provider = deps.provider instanceof RecordingProvider ? deps.provider : new RecordingProvider(deps.provider, deps.store);
  const onboarding = createOnboarding({ store: deps.store, provider, config: deps.config, logger: deps.logger, now: deps.now });
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
      await deps.respond?.(call);
    },
  });
  return {
    handle: (event: InboundEvent) => pipeline.handle(event),
    pipeline,
    provider,
    onboarding,
  };
}

export type Nod = ReturnType<typeof createNod>;
