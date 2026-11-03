import { describe, expect, it } from "vitest";
import { introducedName } from "./names";

describe("introducedName", () => {
  it.each([
    ["Hey Nod! I'm Will.", "Will"],
    ["Hey Nod! I’m Will.", "Will"],
    ["hi nod, this is Sarah", "Sarah"],
    ["I'm Jo-Anne", "Jo-Anne"],
    ["My name is Mike and I heard about you", "Mike"],
    ["Hey, it's Priya!", "Priya"],
    ["@Nod I am Luis", "Luis"],
  ])("reads %j as %s", (text, name) => {
    expect(introducedName(text)).toBe(name);
  });

  it.each([
    "Hey Nod",
    "hi what is this",
    "I'm interested",
    "I'm Interested in trying this",
    "I'm Not sure what this is",
    "i'm will", // a lowercase word isn't taken as a name
    "So my friend said I'm Gonna love this", // not at the start
    "It's Saturday and we need dinner",
    "I'm A",
  ])("finds no name in %j", (text) => {
    expect(introducedName(text)).toBeNull();
  });
});
