import { describe, expect, it } from "vitest";
import { applyAnswer, formatRange, parseAvailability, pickDates } from "./availability";

describe("parseAvailability", () => {
  it.each([
    ["1 3", { mode: "set", positions: [1, 3] }],
    ["1, 3", { mode: "set", positions: [1, 3] }],
    ["1 and 3", { mode: "set", positions: [1, 3] }],
    ["#2", { mode: "set", positions: [2] }],
    ["2 works", { mode: "set", positions: [2] }],
    ["1 & 2 work for me", { mode: "set", positions: [1, 2] }],
    ["only 3", { mode: "set", positions: [3] }],
    ["also 2", { mode: "add", positions: [2] }],
    ["3 too", { mode: "add", positions: [3] }],
    ["can't do 2", { mode: "remove", positions: [2] }],
    ["not 1", { mode: "remove", positions: [1] }],
    ["all", { mode: "all" }],
    ["any work", { mode: "all" }],
    ["all of them work!", { mode: "all" }],
    ["none", { mode: "none" }],
    ["none work", { mode: "none" }],
    ["can't do any", { mode: "none" }],
  ] as const)("reads %j", (text, expected) => {
    expect(parseAvailability(text, 3)).toEqual(expected);
  });

  it.each(["4", "1 4", "I can do 3 people", "see you at 2", "lol", "2pm works", "all good", "none of your business", "$1", "1st"])(
    "ignores %j",
    (text) => {
      expect(parseAvailability(text, 3)).toBeNull();
    },
  );
});

describe("applyAnswer", () => {
  it("replaces, adds and removes", () => {
    expect(applyAnswer([1], { mode: "set", positions: [2, 3] }, 3)).toEqual([2, 3]);
    expect(applyAnswer([1], { mode: "add", positions: [3] }, 3)).toEqual([1, 3]);
    expect(applyAnswer([1, 3], { mode: "remove", positions: [1] }, 3)).toEqual([3]);
    expect(applyAnswer(undefined, { mode: "all" }, 3)).toEqual([1, 2, 3]);
    expect(applyAnswer([2], { mode: "none" }, 3)).toEqual([]);
  });

  it("reads a first answer of \"can't do 2\" as every other choice working", () => {
    expect(applyAnswer(undefined, { mode: "remove", positions: [2] }, 3)).toEqual([1, 3]);
  });
});

describe("pickDates", () => {
  const choices = [
    { position: 1, startsOn: "2027-03-07" },
    { position: 2, startsOn: "2027-03-14" },
    { position: 3, startsOn: "2027-03-21" },
  ];

  it("picks the choice that works for the most people", () => {
    expect(pickDates(choices, [[1, 2], [2], [2, 3]])).toEqual({ position: 2, count: 3 });
  });

  it("breaks ties with the earlier dates", () => {
    expect(pickDates(choices, [[3], [1]])).toEqual({ position: 1, count: 1 });
  });

  it("returns null when nothing works for anyone", () => {
    expect(pickDates(choices, [[], []])).toBeNull();
    expect(pickDates(choices, [])).toBeNull();
  });
});

describe("formatRange", () => {
  it("shows single days and ranges compactly", () => {
    expect(formatRange("2027-03-14")).toBe("Sun, Mar 14");
    expect(formatRange("2027-03-14", "2027-03-18")).toBe("Mar 14–18");
    expect(formatRange("2027-03-30", "2027-04-03")).toBe("Mar 30 – Apr 3");
    expect(formatRange("2027-12-30", "2028-01-02")).toBe("Dec 30, 2027 – Jan 2, 2028");
  });
});
