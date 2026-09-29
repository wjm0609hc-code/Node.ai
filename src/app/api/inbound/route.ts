import { getContainer } from "../../../server/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const { inboundRoute } = await getContainer();
  return inboundRoute(req);
}
