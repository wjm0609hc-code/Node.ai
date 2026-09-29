// Nod's contact card. Sendblue attaches it by URL so people save Nod as "Nod".
import { buildVCard } from "../../onboarding/text";
import { appConfig } from "../../server/config";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const config = appConfig();
  const vcf = buildVCard({ name: "Nod", phone: config.selfPhone, photoUrl: config.logoUrl });
  return new Response(vcf, {
    headers: { "content-type": "text/vcard; charset=utf-8", "content-disposition": 'attachment; filename="Nod.vcf"' },
  });
}
