// Runs database migrations during a Vercel deploy, before the app is built, so the tables
// are always up to date without anyone running a command. Skips quietly when no database
// is configured (e.g. preview builds without the variables). A failed migration fails the deploy.
import { execFileSync } from "node:child_process";

const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!url) {
  console.log("No DATABASE_MIGRATION_URL or DATABASE_URL set; skipping migrations.");
  process.exit(0);
}
console.log("Applying database migrations…");
execFileSync("npx", ["drizzle-kit", "migrate"], { stdio: "inherit" });
console.log("Migrations applied.");
