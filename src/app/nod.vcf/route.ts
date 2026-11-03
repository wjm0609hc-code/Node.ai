// Nod's contact card. Sendblue attaches it by URL so people save Nod as "Nod",
// with the logo embedded as the contact photo.
import { buildVCard } from "../../onboarding/text";
import { appConfig } from "../../server/config";
import { nodPhotoJpeg } from "../../site/photo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const config = appConfig();
  const photoJpeg = await nodPhotoJpeg().catch(() => undefined);
  const vcf = buildVCard({ name: "Nod", phone: config.selfPhone, photoUrl: config.logoUrl, ...(photoJpeg ? { photoJpeg } : {}) });
  return new Response(vcf, {
    headers: { "content-type": "text/vcard; charset=utf-8", "content-disposition": 'attachment; filename="Nod.vcf"' },
  });
}
