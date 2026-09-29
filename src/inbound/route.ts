// Framework-agnostic handler for POST /api/inbound (the Next.js route wraps it).

import { timingSafeEqual } from "node:crypto";
import type { InboundEvent } from "../messaging/types";
import type { Logger } from "../lib/log";
import type { InboundPipeline } from "./pipeline";

export interface InboundRouteDeps {
  /** Shared secret, passed as ?token= on the webhook URL registered with the provider. */
  secret: string;
  parse: (body: unknown) => InboundEvent | null;
  pipeline: Pick<InboundPipeline, "handle">;
  logger: Logger;
  /** Async additions after parsing, e.g. fetching shared contact cards. */
  enrich?: (event: InboundEvent) => Promise<InboundEvent>;
  /** Runs replies after the response is sent (Next.js `after`), so slow Claude calls don't hold the webhook. */
  defer?: (task: () => Promise<void>) => void;
}

export function createInboundRoute(deps: InboundRouteDeps) {
  return async function POST(req: Request): Promise<Response> {
    if (!deps.secret) {
      deps.logger.error("inbound.no_secret_configured");
      return json(500, { error: "webhook secret not configured" });
    }
    const token = new URL(req.url).searchParams.get("token") ?? "";
    if (!safeEqual(token, deps.secret)) return json(401, { error: "unauthorized" });

    let event: InboundEvent | null;
    try {
      event = deps.parse(JSON.parse(await req.text()));
    } catch (err) {
      deps.logger.warn("inbound.bad_payload", { error: (err as Error).message });
      return json(400, { error: "bad payload" });
    }
    if (!event) return json(200, { status: "ignored" });

    try {
      if (deps.enrich) event = await deps.enrich(event);
      const result = deps.defer ? await deps.pipeline.handle(event, { defer: deps.defer }) : await deps.pipeline.handle(event);
      return json(200, { status: result.status });
    } catch (err) {
      // 500 so the provider retries; the message-id claim makes retries safe.
      deps.logger.error("inbound.pipeline_failed", { error: (err as Error).name });
      return json(500, { error: "internal error" });
    }
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
