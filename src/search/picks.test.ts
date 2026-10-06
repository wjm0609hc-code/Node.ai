import { describe, expect, it } from "vitest";
import { extractJson, formatPickCard, validatePicks, type Pick } from "./picks";

const pick = (over: Partial<Pick> = {}): Pick => ({
  name: "Hartwood",
  kind: "restaurant",
  summary: "Wood-fired Mexican on the beach road",
  url: "https://www.hartwoodtulum.com/",
  ...over,
});

describe("formatPickCard", () => {
  it("formats one short line", () => {
    expect(formatPickCard(pick({ when: "Open until 11pm", priceHint: "$$$" }))).toBe(
      "Hartwood · Wood-fired Mexican on the beach road · Open until 11pm · $$$ · hartwoodtulum.com",
    );
    expect(formatPickCard(pick({ summary: "" }))).toBe("Hartwood · hartwoodtulum.com");
  });
});

describe("validatePicks", () => {
  const seen = ["https://www.hartwoodtulum.com/menu", "https://www.tripadvisor.com/Attraction-123", "https://ra.co/events/99"];

  it("keeps picks whose link came from the search results (same site)", () => {
    const out = validatePicks(
      [
        pick(),
        pick({ name: "Gitano", url: "https://gitanotulum.com/" }), // never appeared in results: invented or unverified
        pick({ name: "Cenote tour", kind: "activity", url: "https://tripadvisor.com/Attraction-123" }),
        pick({ name: "", url: "https://ra.co/events/99" }),
        pick({ name: "Bad link", url: "javascript:alert(1)" }),
      ],
      seen,
    );
    expect(out.map((p) => p.name)).toEqual(["Hartwood", "Cenote tour"]);
  });

  it("keeps a phone number when the search found one", () => {
    const [p] = validatePicks([pick({ phone: "+52 984 123 4567" }), pick({ name: "No digits", phone: "call us" })], seen);
    expect(p!.phone).toBe("+52 984 123 4567");
    expect(validatePicks([pick({ phone: "call us" })], seen)[0]!.phone).toBeUndefined();
  });

  it("keeps a price hint only when it reads as a price", () => {
    const hints = ["$$$", "$40 per person", "Free", "€25", "Book online for up to 12; call for large", "4.4 on OpenTable"];
    expect(hints.map((h) => validatePicks([pick({ priceHint: h })], seen)[0]!.priceHint)).toEqual(["$$$", "$40 per person", "Free", "€25", undefined, undefined]);
  });

  it("cleans fields and caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => pick({ name: `  Place ${i}  `, kind: "bogus" as never }));
    const out = validatePicks(many, seen);
    expect(out).toHaveLength(8);
    expect(out[0]).toMatchObject({ name: "Place 0", kind: "other" });
  });
});

describe("extractJson", () => {
  it.each([
    ['{"picks":[]}', { picks: [] }],
    ['Here you go:\n```json\n{"picks":[1]}\n```', { picks: [1] }],
    ['Sure. {"picks":[{"a":1}]} Enjoy!', { picks: [{ a: 1 }] }],
  ])("%j", (text, value) => {
    expect(extractJson(text)).toEqual(value);
  });

  it("returns null when there is no JSON", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});
