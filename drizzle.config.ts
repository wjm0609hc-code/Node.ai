import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Migrations need a session (direct or session-pooler) connection; the app can use the transaction pooler.
  dbCredentials: { url: process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || "" },
});
