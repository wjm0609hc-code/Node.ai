// Venmo pay links for tab summaries. Nod never handles the money: the link opens
// Venmo with the recipient and amount filled in, and the payer sends it themselves.
//
// TODO(verify against Venmo before launch): the web pay-link parameters
// (txn, recipients, amount, note) come from public links, not official documentation.

/** A Venmo username from "@will-m", "will-m", or a venmo.com profile link. Null when it isn't one. */
export function parseVenmoHandle(raw: string): string | null {
  const t = raw.trim();
  const fromLink = /(?:^|\/\/)(?:www\.|account\.)?venmo\.com\/(?:u\/)?@?([A-Za-z0-9_-]+)/i.exec(t)?.[1];
  const handle = (fromLink ?? t.replace(/^@/, "")).trim();
  return /^[A-Za-z0-9_-]{5,30}$/.test(handle) ? handle : null;
}

/** Opens Venmo to pay `handle` this amount, with a note. */
export function venmoPayLink(handle: string, cents: number, note: string): string {
  const q = new URLSearchParams({ txn: "pay", recipients: handle, amount: (cents / 100).toFixed(2), note: note.slice(0, 60) });
  return `https://venmo.com/?${q.toString()}`;
}
