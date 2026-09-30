// Date polls: reading "which dates work for you" replies, and picking the dates
// that work for the most people. Pure functions.

export type Answer =
  | { mode: "set" | "add" | "remove"; positions: number[] }
  | { mode: "all" }
  | { mode: "none" };

const ALL = /^\s*(?:all|any|all of them|any of them|every one|everything|all (?:dates|options))(?:\s+(?:work|works|are fine|good for me|work for me))?\s*[.!]*\s*$/i;
const NONE = /^\s*(?:none|neither|none of them|can'?t do any|cannot do any|nothing works|none work|none of those work|none of them work)\s*[.!]*\s*$/i;
const NUMS = String.raw`#?[1-9](?:\s*(?:,|&|\+|and|or|\s)\s*#?[1-9])*`;
const REMOVE = new RegExp(String.raw`^\s*(?:not|no|can'?t do|cannot do|can'?t make)\s+(${NUMS})\s*[.!]*\s*$`, "i");
const ADD = new RegExp(String.raw`^\s*(?:(?:also|plus|and)\s+(${NUMS})|(${NUMS})\s+(?:too|also|as well))\s*[.!]*\s*$`, "i");
const SET = new RegExp(String.raw`^\s*(?:only\s+|just\s+)?(${NUMS})(?:\s+(?:works?|is good|are good|for me|works? for me|both|either))*\s*[.!]*\s*$`, "i");

function numbers(s: string, n: number): number[] | null {
  const found = [...s.matchAll(/[1-9]/g)].map((m) => Number(m[0]));
  if (!found.length || found.some((x) => x > n)) return null;
  return [...new Set(found)].sort((a, b) => a - b);
}

/** Reads an answer to a date poll with `n` choices. Null when the message isn't one. */
export function parseAvailability(text: string, n: number): Answer | null {
  if (ALL.test(text)) return { mode: "all" };
  if (NONE.test(text)) return { mode: "none" };
  for (const [re, mode] of [
    [REMOVE, "remove"],
    [ADD, "add"],
    [SET, "set"],
  ] as const) {
    const m = re.exec(text);
    if (!m) continue;
    const positions = numbers(m[1] ?? m[2] ?? "", n);
    return positions ? { mode, positions } : null;
  }
  return null;
}

/** A person's available choices after this answer. A first answer of "can't do 2" means every other choice works. */
export function applyAnswer(current: number[] | undefined, answer: Answer, n: number): number[] {
  const all = Array.from({ length: n }, (_, i) => i + 1);
  const now = new Set(current ?? (answer.mode === "remove" ? all : []));
  switch (answer.mode) {
    case "all":
      return all;
    case "none":
      return [];
    case "set":
      return [...answer.positions];
    case "add":
      answer.positions.forEach((p) => now.add(p));
      break;
    case "remove":
      answer.positions.forEach((p) => now.delete(p));
      break;
  }
  return [...now].sort((a, b) => a - b);
}

/** The choice available to the most people; ties go to the earlier dates. Null if nothing works for anyone. */
export function pickDates(choices: Array<{ position: number; startsOn: string }>, answers: number[][]): { position: number; count: number } | null {
  let best: { position: number; count: number; startsOn: string } | null = null;
  for (const c of choices) {
    const count = answers.filter((a) => a.includes(c.position)).length;
    if (!count) continue;
    if (!best || count > best.count || (count === best.count && c.startsOn < best.startsOn)) best = { position: c.position, count, startsOn: c.startsOn };
  }
  return best && { position: best.position, count: best.count };
}

const md = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const wmd = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const mdy = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const at = (d: string) => new Date(`${d}T00:00:00Z`);

/** "Sun, Mar 14", "Mar 14–18", "Mar 30 – Apr 3". */
export function formatRange(startsOn: string, endsOn?: string | null): string {
  if (!endsOn || endsOn === startsOn) return wmd.format(at(startsOn));
  const [a, b] = [at(startsOn), at(endsOn)];
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${mdy.format(a)} – ${mdy.format(b)}`;
  if (a.getUTCMonth() === b.getUTCMonth()) return `${md.format(a)}–${b.getUTCDate()}`;
  return `${md.format(a)} – ${md.format(b)}`;
}
