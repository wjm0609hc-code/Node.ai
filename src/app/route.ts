// "/": the public home page (src/site/landing.ts).
import { renderLanding } from "../site/landing";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const html = renderLanding({ nodPhone: process.env.SENDBLUE_FROM_NUMBER ?? "", appUrl: process.env.NOD_APP_URL });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
