// Public URLs and identity for Nod, from environment variables.

export function appConfig(env: NodeJS.ProcessEnv = process.env) {
  const appUrl = normalizeUrl(env.NOD_APP_URL ?? "");
  return {
    appUrl,
    selfPhone: env.SENDBLUE_FROM_NUMBER ?? "",
    logoUrl: env.NOD_LOGO_URL || `${appUrl}/nod-logo.png`,
    howToVideoUrl: env.NOD_HOWTO_VIDEO_URL || `${appUrl}/add-nod.mp4`,
    contactCardUrl: `${appUrl}/nod.vcf`,
    /** Default timezone for group deadlines until a group sets its own. */
    timezone: env.NOD_TIMEZONE || "America/New_York",
    /** Whether being in a group with Nod gets people access right away ("access", default) or a place on the waitlist. */
    contactEmail: env.NOD_CONTACT_EMAIL?.trim() || undefined,
    groupSignup: (env.NOD_GROUP_SIGNUP === "waitlist" ? "waitlist" : "access") as "access" | "waitlist",
  };
}

/** Lowercase scheme and host, no trailing slash (a typed "HTTPS://NOD.EXAMPLE.COM/" still sends tidy links). */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}
