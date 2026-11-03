import { describe, expect, it } from "vitest";
import { nameClues } from "./name-clues";

describe("nameClues", () => {
  it("finds names people use for each other, around money and when addressing someone", () => {
    const texts = [
      "Yeah will the big one. Tho we did some damage at Bowery somehow. $324 was mine",
      "Brian just send me half I owe you from uber too",
      "Petey - send me $386 total. Brian send me $30 (minus uber)",
      "I paid that. Brian paid $324",
    ];
    expect(nameClues(texts, ["Will"])).toEqual(["Brian", "Petey"]);
  });

  it("skips names Nod already knows and words that aren't names", () => {
    expect(nameClues(["Thanks Will", "Sorry, my bad", "Friday - who's in?", "Venmo is easier"], ["Will"])).toEqual([]);
  });
});
