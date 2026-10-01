// Wires production dependencies from environment variables, once per server instance.

import { after } from "next/server";
import { createResponder } from "../agent/responder";
import { createDb } from "../db/client";
import { DrizzleStore } from "../db/store";
import { createClaudeAnswerClassifier } from "../detection/answer-classifier";
import { createClaudeClassifier } from "../detection/classifier";
import { createInboundRoute } from "../inbound/route";
import { consoleLogger } from "../lib/log";
import { SendblueProvider } from "../messaging/sendblue/provider";
import { attachContactCards } from "../messaging/sendblue/vcards";
import { parseSendblueWebhook } from "../messaging/sendblue/webhook";
import { createNod } from "../nod";
import { webListingFetcher } from "../rentals/fetch";
import { createClaudeSearcher } from "../search/claude-searcher";
import { inngest } from "../jobs/client";
import { InngestScheduler } from "../jobs/scheduler";
import { replyEvent } from "../jobs/reply";
import { createStripeGateway } from "../payments/stripe-gateway";
import { createClaudeReceiptReader } from "../tab/claude-receipts";
import { appConfig } from "./config";

async function build() {
  const logger = consoleLogger();
  const config = appConfig();
  const store = new DrizzleStore(await createDb());
  const sendblue = SendblueProvider.fromEnv(process.env, () => config.contactCardUrl, (event, fields) => logger.warn(event, fields));
  const nod = createNod({
    store,
    provider: sendblue,
    classify: createClaudeClassifier(),
    classifyAnswer: createClaudeAnswerClassifier(),
    logger,
    config: { howToVideoUrl: config.howToVideoUrl, logoUrl: config.logoUrl, appUrl: config.appUrl, timezone: config.timezone },
    scheduler: new InngestScheduler(inngest),
    // Add partner adapters (src/booking/partners.ts) here as API access is approved; until then every booking is a link hand-off.
    bookingPartners: [],
    // Payments are on once Stripe keys are set (see .env.example).
    ...(process.env.STRIPE_SECRET_KEY
      ? { paymentGateway: createStripeGateway({ secretKey: process.env.STRIPE_SECRET_KEY, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "" }) }
      : {}),
    searcher: createClaudeSearcher(),
    receiptReader: createClaudeReceiptReader(),
    fetchListing: webListingFetcher,
    makeResponder: (env) => createResponder(env),
  });
  const inboundRoute = createInboundRoute({
    secret: process.env.SENDBLUE_WEBHOOK_SECRET ?? "",
    parse: (body) => parseSendblueWebhook(body, nod.provider.selfPhone),
    enrich: (event) => attachContactCards(event),
    pipeline: nod,
    logger,
    // Replies run as a retrying Inngest job; if Inngest can't be reached, after the webhook has answered.
    enqueue: async (call) => {
      await inngest.send(replyEvent(call));
    },
    defer: (task) => after(task),
  });
  return { store, nod, inboundRoute, logger };
}

let container: ReturnType<typeof build> | undefined;
let storeOnly: Promise<DrizzleStore> | undefined;

/** Just the database, for web pages that only read (no Sendblue needed). */
export function getStore(): Promise<DrizzleStore> {
  storeOnly ??= createDb().then((db) => new DrizzleStore(db)).catch((err) => {
    storeOnly = undefined;
    throw err;
  });
  return storeOnly;
}

export function getContainer() {
  container ??= build().catch((err) => {
    container = undefined; // retry on the next request
    throw err;
  });
  return container;
}
