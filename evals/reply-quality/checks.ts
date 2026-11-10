// The automatic checks: Nod's house rules (CLAUDE.md, "How you reply") as code. Each check gets
// what happened on one step and returns a failure reason, or nothing when it passes. Pure, so the
// checks themselves are unit-tested (checks.test.ts).

import type { Step } from "./cases";

export interface StepOutcome {
  /** Messages Nod sent to the group for this step, in order (its reply, card pictures, vote options…). */
  sent: Array<{ text: string; hasMedia: boolean }>;
  /** Nod's own reply text (what Claude wrote), or "" when it chose to stay silent or wasn't called. */
  replyText: string;
  /** Tools Nod used for this step, in order. */
  tools: string[];
  /** Whether Claude was asked at all (the message reached Nod). */
  called: boolean;
}

export interface CheckResult {
  id: string;
  pass: boolean;
  detail?: string;
}

const URL_RE = /https?:\/\/\S*[^\s.,!?)]/gi; // a trailing "." or "?" ends the sentence, not the link
// "I can't…", "I'm not able to…", "as an AI": Nod never explains its own limits.
const LIMITS = /\b(i can'?t|i cannot|i'?m not able|i am not able|i'?m unable|i am unable|unable to|as an ai|i don'?t have (?:access|the ability)|my (?:limits|limitations))\b/i;
const LIST_LINE = /^\s*(?:[-*•]\s|\d+[.)]\s)/m;
const MARKDOWN = /\*\*|__|^#{1,6}\s|`/m;

/** Sentences in a reply, ignoring links and decimal points ("$12.50"). */
export function sentenceCount(text: string): number {
  const plain = text.replace(URL_RE, "link").replace(/(\d)\.(\d)/g, "$1$2").trim();
  if (!plain) return 0;
  return plain.split(/(?<=[.!?…])\s+(?=\S)/u).filter((s) => /\w/.test(s)).length;
}

export function questionCount(text: string): number {
  return (text.replace(URL_RE, "").match(/\?/g) ?? []).length;
}

/** Every automatic check for one step. */
export function checkStep(step: Step, o: StepOutcome): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (id: string, pass: boolean, detail?: string) => out.push({ id, pass, ...(pass || !detail ? {} : { detail }) });
  const spoke = o.sent.length > 0;

  if (step.expect.reply === "silent") {
    add("stays_silent", !spoke, `Nod sent ${o.sent.length} message(s): “${o.sent.map((m) => m.text).join(" / ").slice(0, 160)}”`);
    return out;
  }

  add("replies", spoke, o.called ? "Nod was called but sent nothing." : "The message never reached Nod (it wasn't treated as addressed).");
  for (const tool of step.expect.calls ?? []) add(`calls_${tool}`, o.tools.includes(tool), `Didn't use ${tool} (used: ${o.tools.join(", ") || "nothing"}).`);
  for (const tool of step.expect.avoid ?? []) add(`avoids_${tool}`, !o.tools.includes(tool), `Used ${tool}, which it shouldn't here.`);

  const t = o.replyText.trim();
  if (t) {
    const sentences = sentenceCount(t);
    add("short", sentences <= 2 && t.length <= 300, `${sentences} sentences, ${t.length} characters (limit: 2 sentences, 300 characters).`);
    add("one_question_at_most", questionCount(t) <= 1, `Asks ${questionCount(t)} questions.`);
    add("no_lists_or_markdown", !LIST_LINE.test(t) && !MARKDOWN.test(t), "Has a list or markdown.");
    add("no_explaining_limits", !LIMITS.test(t), `Explains its limits: “${t.match(LIMITS)?.[0]}”.`);
    // Cards carry the links; Nod's own words never paste them.
    add("no_pasted_links", !URL_RE.test(t), "Pastes a link in its own text.");
    URL_RE.lastIndex = 0;
  }
  return out;
}
