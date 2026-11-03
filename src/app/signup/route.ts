// POST /signup: the home page's form (src/site/signup.ts). Answers with a page, so it
// works without JavaScript.
import { renderLanding, renderSignupDone } from "../../site/landing";
import { createWebSignup } from "../../site/signup";
import { getContainer } from "../../server/container";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });

export function GET(req: Request): Response {
  return Response.redirect(new URL("/", req.url), 303);
}

export async function POST(req: Request): Promise<Response> {
  const nodPhone = process.env.SENDBLUE_FROM_NUMBER ?? "";
  // Only our own page may post here.
  const origin = req.headers.get("origin");
  if (origin && origin !== "null" && new URL(origin).host !== new URL(req.url).host) return html("Forbidden", 403);

  const form = await req.formData().catch(() => null);
  const field = (k: string) => {
    const v = form?.get(k);
    return typeof v === "string" ? v.slice(0, 100) : "";
  };
  const values = { name: field("name"), phone: field("phone") };
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || req.headers.get("x-real-ip") || "";

  const { nod, store, logger } = await getContainer();
  const signup = createWebSignup({
    store,
    signUp: (input) => nod.invites.signUpFromWeb(input),
    salt: process.env.NOD_SIGNUP_SALT ?? process.env.SENDBLUE_WEBHOOK_SECRET ?? "nod",
    logger,
  });
  try {
    const result = await signup.handle({ ...values, website: field("website") }, ip);
    if (result.status === "invalid_phone") {
      return html(renderLanding({ nodPhone, appUrl: process.env.NOD_APP_URL, error: "That number doesn't look right. Try it with the area code.", values }), 400);
    }
    return html(renderSignupDone({ nodPhone, status: result.status, phone: result.status === "sent" ? result.phone : undefined }), result.status === "busy" ? 429 : 200);
  } catch (err) {
    logger.error("signup.failed", { error: String(err) });
    return html(renderLanding({ nodPhone, appUrl: process.env.NOD_APP_URL, error: "Something went wrong on our end. Try again in a minute.", values }), 500);
  }
}
