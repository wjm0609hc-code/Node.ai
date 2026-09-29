// Wires production dependencies from environment variables, once per server instance.

import { after } from "next/server";
import { createResponder } from "../agent/responder";
import { defaultTools } from "../agent/tools/index";
import { createDb } from "../db/client";
import { DrizzleStore } from "../db/store";
import { createClaudeClassifier } from "../detection/classifier";
import { createInboundRoute } from "../inbound/route";
import { consoleLogger } from "../lib/log";
import { SendblueProvider } from "../messaging/sendblue/provider";
import { attachContactCards } from "../messaging/sendblue/vcards";
import { parseSendblueWebhook } from "../messaging/sendblue/webhook";
import { createNod } from "../nod";
import { appConfig } from "./config";

async function build() {
  const logger = consoleLogger();
  const config = appConfig();
  const store = new DrizzleStore(await createDb());
  const sendblue = SendblueProvider.fromEnv(process.env, () => config.contactCardUrl);
  const nod = createNod({
    store,
    provider: sendblue,
    classify: createClaudeClassifier(),
    logger,
    config: { howToVideoUrl: config.howToVideoUrl, logoUrl: config.logoUrl },
    makeResponder: (env) => createResponder({ ...env, tools: defaultTools }),
  });
  const inboundRoute = createInboundRoute({
    secret: process.env.SENDBLUE_WEBHOOK_SECRET ?? "",
    parse: (body) => parseSendblueWebhook(body, nod.provider.selfPhone),
    enrich: (event) => attachContactCards(event),
    pipeline: nod,
    logger,
    // Reply after the webhook has answered; Claude and tools can take several seconds.
    defer: (task) => after(task),
  });
  return { store, nod, inboundRoute };
}

let container: ReturnType<typeof build> | undefined;

export function getContainer() {
  container ??= build().catch((err) => {
    container = undefined; // retry on the next request
    throw err;
  });
  return container;
}
