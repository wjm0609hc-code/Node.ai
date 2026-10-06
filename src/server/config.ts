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
