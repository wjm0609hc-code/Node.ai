// Home-page sign-up: someone types their name and number, and Nod texts them (the
// waitlist texts, or the welcome if they're already in a group with Nod). The page
// always answers "check your texts" for a valid number, so it never reveals who uses Nod.
//
// Nod texts first here, so the limits stop the form being used to text strangers:
// one text per number per day, five per network per hour, and a ceiling overall.

import { createHash } from "node:crypto";
import type { Store } from "../db/store";
import type { Logger } from "../lib/log";
import type { Phone } from "../messaging/types";
import { normalizePhone } from "../onboarding/text";

export const SIGNUP_LIMITS = { perPhonePerDay: 1, perNetworkPerHour: 5, overallPerHour: 300 };
const HOUR = 3_600_000;

export interface SignupForm {
  name?: string | null;
  phone?: string | null;
  /** A hidden field people never see; bots fill it in. */
  website?: string | null;
}

export type SignupResult =
  | { status: "sent"; phone: Phone }
  | { status: "invalid_phone" }
  | { status: "busy" };

export interface WebSignupDeps {
  store: Store;
  signUp: (input: { phone: Phone; name?: string | null }) => Promise<void>;
  /** Salt for hashing addresses (NOD_SIGNUP_SALT); the address itself is never stored. */
  salt: string;
  logger: Logger;
  now?: () => Date;
}

/** First name only, letters and hyphens, capitalised. Empty when nothing usable was typed. */
export function cleanName(raw: string | null | undefined): string | null {
  const first = (raw ?? "").trim().split(/\s+/)[0]?.replace(/[^\p{L}'’-]/gu, "").slice(0, 30) ?? "";
  return first ? first[0]!.toUpperCase() + first.slice(1) : null;
}

export function createWebSignup(deps: WebSignupDeps) {
  const now = deps.now ?? (() => new Date());
  const hashIp = (ip: string) => createHash("sha256").update(`${deps.salt}:${ip}`).digest("hex").slice(0, 32);

  async function handle(form: SignupForm, ip: string): Promise<SignupResult> {
    const phone = normalizePhone(form.phone ?? "");
    if (!phone) return { status: "invalid_phone" };
    if (form.website) return { status: "sent", phone }; // a bot: say the same thing, text nobody

    const ipHash = hashIp(ip || "unknown");
    const t = now().getTime();
    const [byPhone, byNetwork, overall] = await Promise.all([
      deps.store.countWebSignupTexts({ phone }, new Date(t - 24 * HOUR)),
      deps.store.countWebSignupTexts({ ipHash }, new Date(t - HOUR)),
      deps.store.countWebSignupTexts({}, new Date(t - HOUR)),
    ]);
    if (byNetwork >= SIGNUP_LIMITS.perNetworkPerHour || overall >= SIGNUP_LIMITS.overallPerHour) {
      await deps.store.recordWebSignup({ phone, ipHash, texted: false });
      deps.logger.warn("signup.limited", { byNetwork, overall });
      return { status: "busy" };
    }
    if (byPhone >= SIGNUP_LIMITS.perPhonePerDay) {
      await deps.store.recordWebSignup({ phone, ipHash, texted: false });
      return { status: "sent", phone }; // they already got today's text
    }
    await deps.store.recordWebSignup({ phone, ipHash, texted: true });
    await deps.signUp({ phone, name: cleanName(form.name) });
    deps.logger.info("signup.web");
    return { status: "sent", phone };
  }

  return { handle };
}
