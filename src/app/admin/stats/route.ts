// The private stats page. See src/stats/route.ts.
import { appConfig } from "../../../server/config";
import { getStore } from "../../../server/container";
import { createStatsRoute } from "../../../stats/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createStatsRoute({ store: getStore, appUrl: appConfig().appUrl });
