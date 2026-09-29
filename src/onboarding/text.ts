// Parsing helpers for onboarding: phone numbers, shared vCards, the
// "start a group" request and contact-card requests.

import type { ContactCard, Phone } from "../messaging/types";

/** E.164, assuming a US number when no country code is given. Null when it can't be a phone number. */
export function normalizePhone(raw: string): Phone | null {
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (plus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Name and first phone number of each card in a .vcf file. Cards without a usable phone are skipped. */
export function parseVCards(vcf: string): ContactCard[] {
  const unfolded = vcf.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const cards: ContactCard[] = [];
  for (const block of unfolded.split(/^BEGIN:VCARD$/im).slice(1)) {
    const body = block.split(/^END:VCARD$/im)[0] ?? "";
    let fn: string | undefined;
    let n: string | undefined;
    let phone: Phone | null = null;
    for (const line of body.split("\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon).split(";")[0]!.toUpperCase();
      const value = unescape(line.slice(colon + 1).trim());
      if (key === "FN" && value) fn = value;
      else if (key === "N" && value) n = value.split(";").slice(0, 2).reverse().filter(Boolean).join(" ");
      else if (key === "TEL" && !phone) phone = normalizePhone(value.replace(/^tel:/i, ""));
    }
    const name = fn ?? n;
    if (name && phone) cards.push({ name, phone });
  }
  return cards;
}

/** A vCard 3.0 for Nod's own contact card (served at /nod.vcf for Sendblue to attach). */
export function buildVCard(card: ContactCard): string {
  const esc = (v: string) => v.replace(/([\\,;])/g, "\\$1");
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${esc(card.name)}`,
    `N:;${esc(card.name)};;;`,
    `TEL;TYPE=CELL:${card.phone}`,
    ...(card.photoUrl ? [`PHOTO;VALUE=URI:${card.photoUrl}`] : []),
    "END:VCARD",
    "",
  ].join("\r\n");
}

function unescape(v: string): string {
  return v.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ");
}

const START_GROUP =
  /^(?:@?nod[\s,:]+)?(?:(?:hey|hi|ok|okay|yo)[\s,]+(?:@?nod[\s,:]+)?)?(?:can you |could you |please )*(?:start|make|create|set up)\s+(?:a\s+)?(?:new\s+)?group(?:\s+chat)?\b(.*)$/i;

/** Parses "start a group for Tulum with Jake, Sarah, and Mike". Null when the text isn't that request. */
export function parseStartGroup(text: string): { name?: string; people: string[] } | null {
  const m = START_GROUP.exec(text.trim());
  if (!m) return null;
  const rest = m[1]!.trim().replace(/[.!?]+$/, "");
  if (rest && !/^(for|with)\b/i.test(rest)) return null; // "start a group fund"

  let name: string | undefined;
  let people: string[] = [];
  const forWith = /^for\s+(.+?)(?:\s+with\s+(.+))?$/i.exec(rest);
  const withFor = /^with\s+(.+?)(?:\s+for\s+(.+))?$/i.exec(rest);
  if (forWith) {
    name = forWith[1];
    people = splitPeople(forWith[2] ?? "");
  } else if (withFor) {
    people = splitPeople(withFor[1]!);
    name = withFor[2];
  }
  return { name: name?.trim() || undefined, people };
}

function splitPeople(list: string): string[] {
  return list
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

const CARD_REQUEST = /\b(?:your|ur)\s+(?:contact\s+)?card\b|\bcontact card\b|\bsave (?:your |ur )?contact\b/i;

/** "@Nod your card", "save contact", "add me". Only acted on when the message is addressed to Nod. */
export function isCardRequest(text: string): boolean {
  if (CARD_REQUEST.test(text)) return true;
  const bare = text
    .replace(/^\s*(?:@?nod)[\s,:]*/i, "")
    .replace(/[.!?\s]+$/, "")
    .trim();
  return /^add me$/i.test(bare);
}
