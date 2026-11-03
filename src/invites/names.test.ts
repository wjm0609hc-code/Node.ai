import { describe, expect, it } from "vitest";
import { introducedName, isJustHello, stopWord } from "./names";

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

describe("stopWord", () => {
  it.each([["STOP", "stop"], ["stop.", "stop"], ["Unsubscribe", "stop"], ["START", "start"], ["unstop", "start"]] as const)("%s → %s", (t, w) => {
    expect(stopWord(t)).toBe(w);
  });
  it.each(["stop it", "don't stop", "start a group", "end of the day"])("ignores %j", (t) => expect(stopWord(t)).toBeNull());
});

describe("isJustHello", () => {
  it.each(["hey", "Hey Nod", "hi nod!", "Hey Nod! I'm Will.", "yo", "👋", "sign me up", ""])("%j is just hello", (t) => expect(isJustHello(t)).toBe(true));
  it.each(["2", "hey nod who owes me", "what's the tab?", "hi, can you find dinner"])("%j needs an answer", (t) => expect(isJustHello(t)).toBe(false));
});
