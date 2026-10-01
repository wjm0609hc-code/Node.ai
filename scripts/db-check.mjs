// Fails if src/db/schema.ts has changes with no migration in drizzle/.
// Fix by running: npm run db:generate -- --name <what_changed>
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
// drizzle-kit wants paths relative to the working directory.
const tmp = "node_modules/.cache/nod-db-check";
rmSync(join(root, tmp), { recursive: true, force: true });
mkdirSync(join(root, tmp), { recursive: true });
try {
  cpSync(join(root, "drizzle"), join(root, tmp, "drizzle"), { recursive: true });
  const config = join(tmp, "drizzle.config.mjs");
  writeFileSync(join(root, config), `export default { dialect: "postgresql", schema: "./src/db/schema.ts", out: "./${tmp}/drizzle" };\n`);
  const before = readdirSync(join(root, tmp, "drizzle")).length;
  const out = execFileSync("npx", ["drizzle-kit", "generate", "--config", config, "--name", "check"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const added = readdirSync(join(root, tmp, "drizzle")).length - before;
  if (added > 0) {
    console.error("Schema changes without a migration. Run: npm run db:generate -- --name <what_changed>");
    process.exit(1);
  }
  if (!/No schema changes/i.test(out)) {
    console.error(`Couldn't confirm the schema matches the migrations:\n${out}`);
    process.exit(1);
  }
  console.log("Migrations match the schema.");
} finally {
  rmSync(join(root, tmp), { recursive: true, force: true });
}
