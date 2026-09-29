// Calendar invites: /e/{eventId}.ics (the id is an unguessable UUID). Sendblue attaches this URL.
import { buildIcs } from "../../../booking/ics";
import { getStore } from "../../../server/container";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await params;
  const id = file.replace(/\.ics$/i, "");
  const event = await (await getStore()).getEvent(id);
  if (!event) return new Response("Not found", { status: 404 });
  return new Response(buildIcs(event), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${event.title.replace(/[^\w .-]/g, "").slice(0, 60) || "invite"}.ics"`,
      "x-robots-tag": "noindex",
    },
  });
}
