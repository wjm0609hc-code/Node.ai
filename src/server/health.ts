// Is everything Nod needs set up? Used by /api/health and `npm run check`.
// Never includes secret values: only whether each setting is present and well-formed.
import { activePrograms } from "../affiliates/affiliates";


export type CheckStatus = "ok" | "fail" | "off";
export interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
}

type Env = Record<string, string | undefined>;

const E164 = /^\+[1-9]\d{6,14}$/;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function checkConfig(env: Env): Check[] {
  const checks: Check[] = [];
  const need = (name: string, valid: (v: string) => boolean = () => true, hint?: string) => {
    const v = env[name]?.trim();
    if (!v) checks.push({ name, status: "fail", detail: "Not set." });
    else if (!valid(v)) checks.push({ name, status: "fail", detail: hint });
    else checks.push({ name, status: "ok" });
  };

  need("DATABASE_URL", (v) => /^postgres(ql)?:\/\//.test(v), "Should start with postgres://");
  need("NOD_APP_URL", (v) => /^https:\/\/[^/]+$/.test(v), "Should be the public https URL with no trailing slash, e.g. https://nod.example.com");
  need("SENDBLUE_API_KEY_ID");
  need("SENDBLUE_API_SECRET_KEY");
  need("SENDBLUE_FROM_NUMBER", (v) => E164.test(v), "Should be Nod's number in +15551234567 form.");
  need("SENDBLUE_WEBHOOK_SECRET", (v) => v.length >= 24, "Use at least 24 random characters.");
  need("ANTHROPIC_API_KEY");
  need("INNGEST_EVENT_KEY");
  need("INNGEST_SIGNING_KEY");
  const tz = env.NOD_TIMEZONE?.trim();
  if (tz && !validTimezone(tz)) checks.push({ name: "NOD_TIMEZONE", status: "fail", detail: "Not a timezone name like America/New_York." });

  const sk = env.STRIPE_SECRET_KEY?.trim();
  if (!sk) {
    checks.push({ name: "Payments", status: "off", detail: "STRIPE_SECRET_KEY isn't set, so payment tools are off." });
  } else {
    const pk = env.STRIPE_PUBLISHABLE_KEY?.trim() ?? "";
    const mode = (k: string) => (/_live_/.test(k) ? "live" : /_test_/.test(k) ? "test" : "unknown");
    if (!pk) checks.push({ name: "Payments", status: "fail", detail: "STRIPE_PUBLISHABLE_KEY is missing." });
    else if (mode(sk) !== mode(pk)) checks.push({ name: "Payments", status: "fail", detail: "The secret and publishable keys must be the same mode (both test or both live)." });
    else if (!env.STRIPE_WEBHOOK_SECRET?.trim()) checks.push({ name: "Payments", status: "fail", detail: "STRIPE_WEBHOOK_SECRET is missing (the Connect webhook's signing secret)." });
    else checks.push({ name: "Payments", status: "ok", detail: `Stripe ${mode(sk)} mode.` });
  }

  const programs = activePrograms(env);
  checks.push(
    programs.length
      ? { name: "Affiliate links", status: "ok", detail: `${programs.join(", ")}.` }
      : { name: "Affiliate links", status: "off", detail: "No NOD_AFFILIATE_* settings yet, so links go out untagged." },
  );

  checks.push(
    env.NOD_LOGO_URL || env.NOD_HOWTO_VIDEO_URL
      ? { name: "Onboarding media", status: "ok" }
      : { name: "Onboarding media", status: "ok", detail: "Using /nod-logo.png and /add-nod.mp4 from the app; make sure both are in public/." },
  );
  return checks;
}

export interface DatabaseProbe {
  ping(): Promise<void>;
  /** How many migrations have been applied. */
  appliedMigrations(): Promise<number>;
}

export async function checkDatabase(probe: DatabaseProbe, expectedMigrations: number): Promise<Check> {
  try {
    await probe.ping();
  } catch {
    return { name: "Database", status: "fail", detail: "Can't connect." };
  }
  const applied = await probe.appliedMigrations().catch(() => 0);
  return applied >= expectedMigrations
    ? { name: "Database", status: "ok", detail: `${applied} migration${applied === 1 ? "" : "s"} applied.` }
    : { name: "Database", status: "fail", detail: `${applied} of ${expectedMigrations} migrations applied. Run npm run db:migrate.` };
}

export function summarize(checks: Check[]): { ok: boolean; checks: Check[] } {
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}
