import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Production database (Supabase Postgres) from DATABASE_URL. */
export async function createDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (!url) throw new Error("missing env DATABASE_URL");
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  // prepare: false for Supabase's transaction pooler; few connections per serverless instance.
  return drizzle(postgres(url, { prepare: false, max: 5, idle_timeout: 20 }), { schema }) as unknown as Db;
}
