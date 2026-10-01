import { serve } from "inngest/next";
import { inngest } from "../../../jobs/client";
import { functions } from "../../../jobs/functions";

export const runtime = "nodejs";
// Replies with web searches can run past a minute; Vercel caps this by plan.
export const maxDuration = 300;
export const { GET, POST, PUT } = serve({ client: inngest, functions });
