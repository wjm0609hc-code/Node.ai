// When a group has members Nod only knows by number, Claude gets a short list of the
// names people used in the chat that don't belong to anyone Nod knows. Claude matches
// them up quietly with set_member_name (usually there's only one sensible answer), so
// nobody has to tell Nod "Brian is 6249".

import type { Store } from "../db/store";
import type { ContextSection } from "./context";
import { displayName } from "./context";

/** Capitalised words that aren't people's names. */
const NOT_NAMES = new Set(
  (
    "i im ive id ill the a an and but or so ok okay yeah yes no nope yep sure just thanks thank sorry lol haha hey hi hello yo " +
    "nod we you he she they it this that what when where why who how not maybe also then there here today tonight tomorrow " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september " +
    "october november december venmo zelle apple cash uber lyft total tab bill dinner drinks lunch brunch nice cool great " +
    "good all everyone someone guys fellas dude bro man"
  ).split(" "),
);

// A name addressing someone ("Petey - send me", "Brian, you owe"), or a name doing money things.
const PATTERNS = [
  /^([A-Z][a-z]{2,14})\s*[,:–—-]\s/,
  /\b([A-Z][a-z]{2,14})(?:'s|’s)?\s+(?:paid|pays|owes|owe|sent|covered|got|grabbed|bought|had|is|was|will|can|just|venmo(?:ed)?)\b/,
  /\b(?:pay|paid|owe|owes|send|sent|venmo|thanks|tell|ask|from|to)\s+([A-Z][a-z]{2,14})\b/,
];

/** Names used in these messages that don't match a known first name. */
export function nameClues(texts: string[], knownFirstNames: string[]): string[] {
  const known = new Set(knownFirstNames.map((n) => n.toLowerCase()));
  const found: string[] = [];
  for (const t of texts) {
    for (const re of PATTERNS) {
      const m = re.exec(t);
      const name = m?.[1];
      if (!name) continue;
      const k = name.toLowerCase();
      if (NOT_NAMES.has(k) || known.has(k) || found.some((f) => f.toLowerCase() === k)) continue;
      found.push(name);
    }
  }
  return found.slice(0, 6);
}

export function nameCluesSection(store: Store): ContextSection {
  return async (call) => {
    if (!call.groupId) return null;
    const members = await store.groupMembers(call.groupId);
    const unnamed = members.filter((m) => !m.name);
    if (!unnamed.length) return null;
    const recent = await store.recentMessages({ groupId: call.groupId }, 40);
    const firstNames = members.filter((m) => m.name).map((m) => m.name!.split(/\s+/)[0]!);
    const clues = nameClues([...recent.map((r) => r.text), call.event.text], firstNames);
    return {
      title: "names",
      body: [
        `No name yet: ${unnamed.map(displayName).join(", ")}.`,
        clues.length ? `Names used in the chat that don't match anyone you know: ${clues.join(", ")}.` : "",
        "When it's clear which member a name belongs to (only one unnamed member is left, someone talks to them by name and they answer, " +
          "or a payment someone mentions by name matches a message from that member), save it with set_member_name without mentioning it. " +
          "Never hold anything up for a name: use \"ending 1234\" for anyone you can't place.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  };
}
