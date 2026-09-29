// Public URLs and identity for Nod, from environment variables.

export function appConfig(env: NodeJS.ProcessEnv = process.env) {
  const appUrl = (env.NOD_APP_URL ?? "").replace(/\/$/, "");
  return {
    appUrl,
    selfPhone: env.SENDBLUE_FROM_NUMBER ?? "",
    logoUrl: env.NOD_LOGO_URL || `${appUrl}/nod-logo.png`,
    howToVideoUrl: env.NOD_HOWTO_VIDEO_URL || `${appUrl}/add-nod.mp4`,
    contactCardUrl: `${appUrl}/nod.vcf`,
  };
}
