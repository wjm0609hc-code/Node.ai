// Checks your environment before (or after) deploying: every setting Nod needs, and the database.
//   npm run check                 uses .env in this folder if there is one, else your shell's variables
import { existsSync } from "node:fs";
import { createDb } from "../src/db/client";
import { checkConfig, checkDatabase, summarize } from "../src/server/health";
import { databaseProbe, EXPECTED_MIGRATIONS } from "../src/server/health-route";

if (existsSync(".env")) process.loadEnvFile(".env");
// (createDb reads DATABASE_URL when called, so loading .env here is early enough.)
const checks = checkConfig(process.env);
try {
  checks.unshift(await checkDatabase(databaseProbe(await createDb()), EXPECTED_MIGRATIONS));
} catch {
  checks.unshift({ name: "Database", status: "fail", detail: "Can't connect (is DATABASE_URL set?)." });
}
const mark = { ok: "✓", fail: "✗", off: "–" } as const;
for (const c of checks) console.log(`${mark[c.status]} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
const { ok } = summarize(checks);
console.log(ok ? "\nReady." : "\nFix the ✗ items above.");
process.exit(ok ? 0 : 1);
