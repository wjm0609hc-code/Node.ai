import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, findCode, generateCode, normalizeCode } from "./codes";

describe("generateCode", () => {
  it("makes NOD- plus six unambiguous characters with at least one digit", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toMatch(/^NOD-[2-9A-HJKMNP-Z]{6}$/);
      expect(code.slice(4)).toMatch(/[2-9]/);
      expect(code.slice(4)).toMatch(/[A-Z]/);
    }
  });

  it("leaves out characters people mix up", () => {
    expect(CODE_ALPHABET).not.toMatch(/[01ILO]/);
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });

  it("uses the random source it's given", () => {
    const bytes = [0, 1, 2, 3, 4, 8, 255];
    let i = 0;
    const code = generateCode((n) => Uint8Array.from({ length: n }, () => bytes[i++ % bytes.length]!));
    expect(code).toBe("NOD-23456A"); // 255 is skipped (rejection sampling)
  });
});

describe("findCode", () => {
  it.each([
    ["NOD-7K3QXP", "NOD-7K3QXP"],
    ["nod-7k3qxp", "NOD-7K3QXP"],
    ["my code is NOD 7K3QXP thanks", "NOD-7K3QXP"],
    ["Nod7K3QXP", "NOD-7K3QXP"],
    ["NOD–7K3QXP", "NOD-7K3QXP"],
    ["7k3qxp", "NOD-7K3QXP"],
    ["  7K3QXP. ", "NOD-7K3QXP"],
  ])("reads %j", (text, code) => {
    expect(findCode(text)).toBe(code);
  });

  it.each([
    ["hey nod thanks"], // six letters but no digit
    ["nod please"],
    ["hello"],
    ["my number is 555123"], // no letter
    ["NOD-7K3QX"], // too short
    ["NOD-7K3QXPP"], // too long
    ["7K3QXP is the code and also some words"], // a bare code must be the whole message
    ["https://example.com/nod-7k3qxp"],
    ["NOD-0K3QXP"], // 0 isn't in the alphabet
  ])("ignores %j", (text) => {
    expect(findCode(text)).toBeNull();
  });
});

describe("normalizeCode", () => {
  it("accepts codes from links and forms", () => {
    expect(normalizeCode("nod-7k3qxp")).toBe("NOD-7K3QXP");
    expect(normalizeCode(" 7K3QXP ")).toBe("NOD-7K3QXP");
    expect(normalizeCode("<script>")).toBeNull();
    expect(normalizeCode(null)).toBeNull();
  });
});
