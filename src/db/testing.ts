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

export async function resetTestDb(db: TestDb): Promise<void> {
  await db.execute(sql`TRUNCATE events, bookings, votes, decision_options, decisions, pending_questions, searches, options, messages, user_contacts, group_members, groups, users CASCADE`);
}
