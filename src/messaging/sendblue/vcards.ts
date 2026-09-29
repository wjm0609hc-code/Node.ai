// Contact cards people text to Nod arrive from Sendblue as media links to .vcf
// files. Fetch and parse them so onboarding can learn names and numbers.
// TODO(verify against docs.sendblue.com): whether vCard media URLs keep the .vcf extension.

import { requestJson } from "../../lib/http";
import { parseVCards } from "../../onboarding/text";
import type { InboundEvent, InboundMessage } from "../types";

const VCF = /\.vcf(?:$|\?)/i;

export type FetchText = (url: string) => Promise<string>;

export const fetchTextWithRetries: FetchText = async (url) => {
  const body = await requestJson<unknown>(url, { method: "GET" }, { timeoutMs: 5000, retries: 2 });
  return typeof body === "string" ? body : "";
};

export async function attachContactCards<E extends InboundEvent>(event: E, fetchText: FetchText = fetchTextWithRetries): Promise<E> {
  if (event.type !== "message") return event;
  const msg = event as InboundMessage;
  const vcfUrls = msg.mediaUrls.filter((u) => VCF.test(u));
  if (!vcfUrls.length) return event;

  const cards = [];
  const unread: string[] = [];
  for (const url of vcfUrls) {
    try {
      cards.push(...parseVCards(await fetchText(url)));
    } catch {
      unread.push(url);
    }
  }
  if (!cards.length) return event;
  return {
    ...msg,
    mediaUrls: msg.mediaUrls.filter((u) => !VCF.test(u) || unread.includes(u)),
    contactCards: [...(msg.contactCards ?? []), ...cards],
  } as E;
}
