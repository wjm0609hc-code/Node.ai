// Reading votes from chat text and counting them. Pure functions.

import type { Tapback } from "../messaging/types";

export type ParsedVote = { number: number } | { name: string };

const NUMBER_VOTE = /^\s*(?:(?:i\s+)?vote\s+(?:for\s+)?|option\s*|#)?#?\s*([1-9])\s*(?:[.!]+|\s+for\s+me)?\s*$/i;
const NAME_VOTE = /^\s*(?:i\s+)?vote\s+(?:for\s+)?(.{2,60}?)\s*[.!]*\s*$/i;

/** "2", "#2", "option 2", "I vote 2", "2 for me" → a number; "I vote Casa Azul" → a name. Null otherwise. */
export function parseVoteText(text: string, maxOption = 9): ParsedVote | null {
  const n = NUMBER_VOTE.exec(text);
  if (n) {
    const number = Number(n[1]);
    return number >= 1 && number <= maxOption ? { number } : null;
  }
  const name = NAME_VOTE.exec(text);
  if (name && !/^\d/.test(name[1]!)) return { name: name[1]!.trim() };
  return null;
}

const TAPBACK_VERBS: Record<string, Tapback> = {
  loved: "love",
  liked: "like",
  disliked: "dislike",
  "laughed at": "laugh",
  emphasized: "emphasize",
  questioned: "question",
};
const TAPBACK_NOUNS: Record<string, Tapback> = {
  heart: "love",
  like: "like",
  dislike: "dislike",
  laugh: "laugh",
  exclamation: "emphasize",
  "question mark": "question",
};

const REACTION_EMOJI: Record<string, Tapback> = { "❤": "love", "👍": "like", "👎": "dislike", "😂": "laugh", "‼": "emphasize", "❓": "question" };

/** SMS tapback text (`Liked “…”`, `Removed a heart from “…”`) → the tapback and the quoted message text. */
export function parseTapbackText(text: string): { reaction: Tapback; removed: boolean; quoted: string } | null {
  const t = text.trim();
  const added = /^(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned) [“"]([\s\S]*)[”"]$/.exec(t);
  if (added) return { reaction: TAPBACK_VERBS[added[1]!.toLowerCase()]!, removed: false, quoted: added[2]! };
  // iOS 18+ emoji reactions: only the emoji matching a classic tapback count.
  const reacted = /^Reacted (\S{1,8}?) to [“"]([\s\S]*)[”"]$/u.exec(t);
  if (reacted) {
    const reaction = REACTION_EMOJI[reacted[1]!.replace(/\uFE0F/g, "")];
    return reaction ? { reaction, removed: false, quoted: reacted[2]! } : null;
  }
  const removed = /^Removed an? ([\w ]+?) from [“"]([\s\S]*)[”"]$/.exec(t);
  if (removed && TAPBACK_NOUNS[removed[1]!.toLowerCase()]) {
    return { reaction: TAPBACK_NOUNS[removed[1]!.toLowerCase()]!, removed: true, quoted: removed[2]! };
  }
  return null;
}

/** Tapbacks that count as a vote for the option they're on. */
export const VOTING_TAPBACKS = new Set<Tapback>(["love", "like", "emphasize", "laugh"]);

export type Outcome = { kind: "winner"; optionId: string } | { kind: "tie"; optionIds: string[] } | { kind: "none" };

export function tally(optionIds: string[], votes: Array<{ optionId: string }>) {
  const counts: Record<string, number> = Object.fromEntries(optionIds.map((id) => [id, 0]));
  for (const v of votes) if (v.optionId in counts) counts[v.optionId]!++;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const top = Math.max(0, ...Object.values(counts));
  const leaders = optionIds.filter((id) => counts[id] === top);
  const outcome: Outcome =
    total === 0 ? { kind: "none" } : leaders.length === 1 ? { kind: "winner", optionId: leaders[0]! } : { kind: "tie", optionIds: leaders };
  return { counts, total, outcome };
}
