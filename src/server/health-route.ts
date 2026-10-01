// GET /api/health: { ok } for uptime monitors; with the HEALTH_TOKEN (Bearer header or ?token=)
// it lists each check, so you can see what's missing after a deploy. Never shows secret values.
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import journal from "../../drizzle/meta/_journal.json";
import type { Db } from "../db/client";
import { checkConfig, checkDatabase, summarize, type Check } from "./health";

export const EXPECTED_MIGRATIONS = journal.entries.length;

export function databaseProbe(db: Db) {
  return {
    ping: async () => {
      await db.execute(sql`select 1`);
    },
    appliedMigrations: async () => {
      const res = (await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as Array<{ n: number }> | { rows: Array<{ n: number }> };
      const rows = Array.isArray(res) ? res : res.rows;
      return Number(rows[0]?.n ?? 0);
    },
  };
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createHealthRoute(deps: { env?: NodeJS.ProcessEnv; db: () => Promise<Db> }) {
  const env = deps.env ?? process.env;
  return async function GET(req: Request): Promise<Response> {
    const checks: Check[] = checkConfig(env);
    try {
      checks.unshift(await checkDatabase(databaseProbe(await deps.db()), EXPECTED_MIGRATIONS));
    } catch {
      checks.unshift({ name: "Database", status: "fail", detail: "Can't connect." });
    }
    const result = summarize(checks);
    const token = env.HEALTH_TOKEN ?? "";
    const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? new URL(req.url).searchParams.get("token") ?? "";
    const detailed = token.length >= 16 && same(presented, token);
    return new Response(JSON.stringify(detailed ? result : { ok: result.ok }, null, 2), {
      status: result.ok ? 200 : 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };
}
