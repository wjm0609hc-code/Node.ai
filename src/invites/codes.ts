// Invite codes: "NOD-" plus six characters from an alphabet without 0/O, 1/I/L,
// always mixing letters and digits so ordinary words never look like a code.

/** 31 characters; six of them give about 887 million codes. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const LENGTH = 6;
const BODY = `[${CODE_ALPHABET}]{${LENGTH}}`;
const PREFIXED = new RegExp(`(?<![\\w/.-])NOD[\\s:#–—-]*(${BODY})(?![\\w])`, "i");
const BARE = new RegExp(`^\\s*(${BODY})[.!]?\\s*$`, "i");

export type RandomBytes = (n: number) => Uint8Array;
const cryptoBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

const mixed = (body: string) => /[2-9]/.test(body) && /[A-Z]/.test(body);

export function generateCode(random: RandomBytes = cryptoBytes): string {
  // Rejection sampling keeps every character equally likely (248 = 8 × 31).
  for (;;) {
    let body = "";
    while (body.length < LENGTH) {
      for (const b of random(LENGTH * 2)) {
        if (b < 248 && body.length < LENGTH) body += CODE_ALPHABET[b % CODE_ALPHABET.length];
      }
    }
    if (mixed(body)) return `NOD-${body}`;
  }
}

/** The invite code in a message, in canonical form, or null. A bare code counts only as the whole message. */
export function findCode(text: string): string | null {
  const match = PREFIXED.exec(text) ?? BARE.exec(text);
  if (!match) return null;
  const body = match[1]!.toUpperCase();
  return mixed(body) ? `NOD-${body}` : null;
}

/** A code from a link or form field, in canonical form, or null. */
export function normalizeCode(value: string | null | undefined): string | null {
  if (!value || value.length > 20) return null;
  const v = value.trim();
  return new RegExp(`^(NOD[\\s-]*)?${BODY}$`, "i").test(v) ? findCode(v.replace(/^nod[\s-]*/i, "")) : null;
}
