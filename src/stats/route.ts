// GET /admin/stats?token=…&days=7: the private stats page. Needs NOD_STATS_TOKEN (or, if that
// isn't set, HEALTH_TOKEN), at least 16 characters; anything else gets a plain 404.
import { timingSafeEqual } from "node:crypto";
import { USAGE_CARD_LIMIT, type Store } from "../db/store";
import { renderStatsPage } from "./page";
import { summarize } from "./stats";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function statsToken(env: NodeJS.ProcessEnv): string {
  return (env.NOD_STATS_TOKEN?.trim() || env.HEALTH_TOKEN?.trim() || "");
}

export function createStatsRoute(deps: { store: () => Promise<Store>; env?: NodeJS.ProcessEnv; appUrl?: string; now?: () => Date }) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  return async function GET(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const token = statsToken(env);
    const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
    if (token.length < 16 || !same(presented, token)) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    const asked = Number(url.searchParams.get("days") ?? 7);
    const days = Number.isFinite(asked) ? Math.min(365, Math.max(1, Math.round(asked))) : 7;
    const since = new Date(now().getTime() - days * 86_400_000);
    const usage = await (await deps.store()).usageSince(since);
    const stats = summarize(usage, { days, since, appUrl: deps.appUrl, env, cardLimit: USAGE_CARD_LIMIT });
    return new Response(renderStatsPage(stats, { token: presented }), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" },
    });
  };
}
