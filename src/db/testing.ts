// In-process Postgres (PGlite) with the real migrations, for tests and the local simulator.
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "./client";
import * as schema from "./schema";

export type TestDb = Db;

export async function createTestDb(migrationsFolder = "drizzle"): Promise<TestDb> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  return db as unknown as TestDb;
}

/** Empties every table (new tables included automatically). */
export async function resetTestDb(db: TestDb): Promise<void> {
  const res = (await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { rows: Array<{ tablename: string }> };
  const names = res.rows.map((r) => `"${r.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`TRUNCATE ${names} CASCADE`));
}
