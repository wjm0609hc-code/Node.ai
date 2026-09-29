import { describe, expect, it } from "vitest";
import { buildVCard, isCardRequest, normalizePhone, parseStartGroup, parseVCards } from "./text";

describe("normalizePhone", () => {
  it.each([
    ["+1 (555) 020-0002", "+15550200002"],
    ["555-020-0002", "+15550200002"],
    ["15550200002", "+15550200002"],
    ["(555) 020 0002", "+15550200002"],
    ["+44 20 7946 0958", "+442079460958"],
  ])("%s → %s", (raw, e164) => {
    expect(normalizePhone(raw)).toBe(e164);
  });

  it.each(["", "12345", "call me", "+1"])("rejects %j", (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});

describe("parseVCards", () => {
  it("reads name and phone from each card", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Miller;Jake;;;",
      "FN:Jake Miller",
      "TEL;type=CELL;type=VOICE;type=pref:+1 (555) 020-0002",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Chen;Sarah;;;",
      "TEL;TYPE=HOME:555-020-0003",
      "END:VCARD",
    ].join("\r\n");
    expect(parseVCards(vcf)).toEqual([
      { name: "Jake Miller", phone: "+15550200002" },
      { name: "Sarah Chen", phone: "+15550200003" },
    ]);
  });

  it("handles folded lines and escaped characters, and skips cards without a phone", () => {
    const vcf = "BEGIN:VCARD\nFN:Priya \n Patel\\, MD\nTEL:5550200004\nEND:VCARD\nBEGIN:VCARD\nFN:No Phone\nEND:VCARD";
    expect(parseVCards(vcf)).toEqual([{ name: "Priya Patel, MD", phone: "+15550200004" }]);
  });

  it("returns nothing for junk", () => {
    expect(parseVCards("not a vcard")).toEqual([]);
  });
});

describe("buildVCard", () => {
  it("builds a card that parses back, with the photo as a URL", () => {
    const vcf = buildVCard({ name: "Nod", phone: "+15550100000", photoUrl: "https://nod.test/nod.png" });
    expect(vcf).toContain("PHOTO;VALUE=URI:https://nod.test/nod.png");
    expect(vcf.split("\r\n")[0]).toBe("BEGIN:VCARD");
    expect(parseVCards(vcf)).toEqual([{ name: "Nod", phone: "+15550100000" }]);
  });

  it("escapes special characters", () => {
    expect(buildVCard({ name: "Nod, Inc; Bot", phone: "+15550100000" })).toContain("FN:Nod\\, Inc\\; Bot");
  });
});

describe("parseStartGroup", () => {
  it.each([
    ["Start a group for Tulum with Jake, Sarah, and Mike", { name: "Tulum", people: ["Jake", "Sarah", "Mike"] }],
    ["start a group with jake and sarah", { name: undefined, people: ["jake", "sarah"] }],
    ["@Nod start a group for Tulum with Jake & Sarah", { name: "Tulum", people: ["Jake", "Sarah"] }],
    ["Nod, make a group chat for Brunch with 555-020-0003, Dan", { name: "Brunch", people: ["555-020-0003", "Dan"] }],
    ["can you create a group with Priya and Dan for brunch sunday?", { name: "brunch sunday", people: ["Priya", "Dan"] }],
    ["please start a new group for Ski trip", { name: "Ski trip", people: [] }],
    ["start a group", { name: undefined, people: [] }],
    ["Start a group for Tulum with Jake, Sarah and Mike.", { name: "Tulum", people: ["Jake", "Sarah", "Mike"] }],
  ])("%j", (text, expected) => {
    expect(parseStartGroup(text)).toEqual(expected);
  });

  it.each(["what group are we in", "we should start a group fund", "hello", "starting a groupon deal"])("not a request: %j", (text) => {
    expect(parseStartGroup(text)).toBeNull();
  });
});

describe("isCardRequest", () => {
  it.each(["@Nod your card", "send your contact card", "save contact", "add me", "Nod can I get ur card?", "what's your contact card"])(
    "yes: %j",
    (text) => {
      expect(isCardRequest(text)).toBe(true);
    },
  );

  it.each(["@Nod compare these", "add me to the list for dinner", "my card got declined", "cardinal"])("no: %j", (text) => {
    expect(isCardRequest(text)).toBe(false);
  });
});
