import { describe, expect, it } from "vitest";
import { parseTapbackText, parseVoteText, tally } from "./votes";

describe("parseVoteText", () => {
  it.each([
    ["2", { number: 2 }],
    [" #3 ", { number: 3 }],
    ["2!", { number: 2 }],
    ["1.", { number: 1 }],
    ["option 2", { number: 2 }],
    ["Option #4", { number: 4 }],
    ["I vote 2", { number: 2 }],
    ["i vote for 1", { number: 1 }],
    ["vote 3", { number: 3 }],
    ["2 for me", { number: 2 }],
    ["I vote Casa Azul", { name: "Casa Azul" }],
    ["vote for the beach house!", { name: "the beach house" }],
  ])("%j", (text, parsed) => {
    expect(parseVoteText(text)).toEqual(parsed);
  });

  it.each(["2 people are coming", "we need 2 cars", "10", "0", "2?", "7", "hello", "", "my vote doesn't matter"])(
    "not a vote: %j",
    (text) => {
      expect(parseVoteText(text, 6)).toBeNull();
    },
  );
});

describe("parseTapbackText", () => {
  it.each([
    ["Liked “https://www.airbnb.com/rooms/111”", { reaction: "like", removed: false, quoted: "https://www.airbnb.com/rooms/111" }],
    ['Loved "Casa Azul?"', { reaction: "love", removed: false, quoted: "Casa Azul?" }],
    ["Emphasized “this one”", { reaction: "emphasize", removed: false, quoted: "this one" }],
    ["Removed a like from “this one”", { reaction: "like", removed: true, quoted: "this one" }],
    ["Removed a heart from “this one”", { reaction: "love", removed: true, quoted: "this one" }],
  ])("%j", (text, parsed) => {
    expect(parseTapbackText(text)).toEqual(parsed);
  });

  it("returns null for ordinary text", () => {
    expect(parseTapbackText("I liked that one")).toBeNull();
  });
});

describe("tally", () => {
  const opts = ["a", "b", "c"];
  it("finds a winner", () => {
    expect(tally(opts, [{ optionId: "a" }, { optionId: "b" }, { optionId: "a" }])).toEqual({
      counts: { a: 2, b: 1, c: 0 },
      total: 3,
      outcome: { kind: "winner", optionId: "a" },
    });
  });
  it("finds a tie among the leaders", () => {
    expect(tally(opts, [{ optionId: "a" }, { optionId: "b" }, { optionId: "c" }, { optionId: "b" }, { optionId: "a" }]).outcome).toEqual({
      kind: "tie",
      optionIds: ["a", "b"],
    });
  });
  it("reports no votes, and ignores votes for other options", () => {
    expect(tally(opts, [{ optionId: "zzz" }]).outcome).toEqual({ kind: "none" });
  });
});

describe("parseTapbackText: iOS 18 emoji reactions", () => {
  it("counts the emoji that match classic tapbacks", () => {
    expect(parseTapbackText("Reacted 👍 to “Casa Azul”")).toEqual({ reaction: "like", removed: false, quoted: "Casa Azul" });
    expect(parseTapbackText("Reacted ❤️ to “Mar 14–18”")).toEqual({ reaction: "love", removed: false, quoted: "Mar 14–18" });
    expect(parseTapbackText("Reacted ‼️ to “2”")).toMatchObject({ reaction: "emphasize" });
  });

  it("ignores other emoji", () => {
    expect(parseTapbackText("Reacted 🌮 to “Casa Azul”")).toBeNull();
  });
});
