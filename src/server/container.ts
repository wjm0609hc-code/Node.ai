// Wires production dependencies from environment variables, once per server instance.

import { createDb } from "../db/client";
import { MessageStore } from "../db/store";
import { createClaudeClassifier } from "../detection/classifier";
import { createInboundPipeline } from "../inbound/pipeline";
import { RecordingProvider } from "../inbound/recording-provider";
import { createInboundRoute } from "../inbound/route";
import { consoleLogger } from "../lib/log";
import { SendblueProvider } from "../messaging/sendblue/provider";
import { parseSendblueWebhook } from "../messaging/sendblue/webhook";

async function build() {
  const logger = consoleLogger();
  const store = new MessageStore(await createDb());
  const appUrl = process.env.NOD_APP_URL ?? "";
  const sendblue = SendblueProvider.fromEnv(process.env, () => `${appUrl}/nod.vcf`);
  const provider = new RecordingProvider(sendblue, store);
  const pipeline = createInboundPipeline({
    store,
    selfPhone: provider.selfPhone,
    classify: createClaudeClassifier(),
    logger,
    // Phase 1 step 4 replaces this with Claude orchestration.
    onAddressed: async ({ event, decision }) => {
      logger.info("nod.addressed", { messageId: event.messageId, reason: decision.reason });
    },
  });
  const inboundRoute = createInboundRoute({
    secret: process.env.SENDBLUE_WEBHOOK_SECRET ?? "",
    parse: (body) => parseSendblueWebhook(body, provider.selfPhone),
    pipeline,
    logger,
  });
  return { store, provider, pipeline, inboundRoute };
}

let container: ReturnType<typeof build> | undefined;

export function getContainer() {
  container ??= build().catch((err) => {
    container = undefined; // retry on the next request
    throw err;
  });
  return container;
}
