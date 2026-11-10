import { describe, expect, it } from "vitest";
import { CASES } from "./cases";
import type { Step } from "./cases";
import { checkStep, questionCount, sentenceCount, type StepOutcome } from "./checks";

const speak: Step = { who: "will", text: "@Nod x", expect: { reply: "speak", calls: ["search_web"] } };
const silent: Step = { who: "will", text: "lol", expect: { reply: "silent" } };
const said = (replyText: string, tools = ["search_web"]): StepOutcome => ({ sent: [{ text: replyText, hasMedia: false }], replyText, tools, called: true });
const failed = (step: Step, o: StepOutcome) => checkStep(step, o).filter((c) => !c.pass).map((c) => c.id);

describe("counting", () => {
  it("counts sentences, ignoring links and prices", () => {
    expect(sentenceCount("Six spots for 5 at 7. Tap 👍 on your pick.")).toBe(2);
    expect(sentenceCount("Logged $12.50 for tacos.")).toBe(1);
    expect(sentenceCount("See https://get-nod.app/o/abc. Done!")).toBe(2);
    expect(sentenceCount("")).toBe(0);
  });
  it("counts questions outside links", () => {
    expect(questionCount("Where to? https://x.test/?a=1")).toBe(1);
  });
});

describe("the house rules", () => {
  it("passes a short reply that did the job", () => {
    expect(failed(speak, said("Drinks tonight, East Village:"))).toEqual([]);
  });
  it("catches long, listy, questioning, limit-explaining and link-pasting replies", () => {
    expect(failed(speak, said("One. Two. Three."))).toEqual(["short"]);
    expect(failed(speak, said("Where? When?"))).toEqual(["one_question_at_most"]);
    expect(failed(speak, said("Picks:\n- Bistro Verde"))).toEqual(["no_lists_or_markdown"]);
    expect(failed(speak, said("**Bistro Verde** it is."))).toEqual(["no_lists_or_markdown"]);
    expect(failed(speak, said("I can't text people privately here."))).toEqual(["no_explaining_limits"]);
    expect(failed(speak, said("Book here: https://resy.com/x"))).toEqual(["no_pasted_links"]);
  });
  it("checks the actions it had to take and avoid", () => {
    expect(failed(speak, said("On it.", []))).toEqual(["calls_search_web"]);
    const avoid: Step = { ...speak, expect: { reply: "speak", avoid: ["send_balances"] } };
    expect(failed(avoid, said("Done.", ["send_balances"]))).toEqual(["avoids_send_balances"]);
  });
  it("needs a reply when it should speak, and silence when it shouldn't", () => {
    expect(failed(speak, { sent: [], replyText: "", tools: [], called: false })).toContain("replies");
    expect(failed(silent, { sent: [], replyText: "", tools: [], called: true })).toEqual([]);
    expect(failed(silent, said("Haha"))).toEqual(["stays_silent"]);
  });
  it("lets a card-only reply (no text of its own) pass the text rules", () => {
    expect(failed(speak, { sent: [{ text: "1 Bistro Verde · https://get-nod.app/o/a", hasMedia: true }], replyText: "", tools: ["search_web"], called: true })).toEqual([]);
  });
});

describe("the cases", () => {
  it("have unique ids, and say what good looks like on every step that's graded", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const c of CASES) expect(c.steps.at(-1)!.expect.good, c.id).toBeTruthy();
  });
});
