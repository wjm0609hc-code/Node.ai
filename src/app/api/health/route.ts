import { createDb } from "../../../db/client";
import { createHealthRoute } from "../../../server/health-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let db: ReturnType<typeof createDb> | undefined;
export const GET = createHealthRoute({
  db: () => {
    db ??= createDb().catch((err) => {
      db = undefined;
      throw err;
    });
    return db;
  },
});
