import { describe, expect, it } from "vitest";
import { legalSettings, missingLegalSettings, renderPrivacy, renderTerms } from "./legal";
import { renderLanding } from "./landing";

const filled = { company: "Nod Labs, Inc.", email: "help@nod.test", state: "Massachusetts", updated: "2026-11-05" };

describe("legal pages", () => {
  it("show obvious placeholders until the settings are filled in", () => {
    const html = renderPrivacy({});
    expect(html).toContain("[Company name]");
    expect(html).toContain("[contact email]");
    expect(renderTerms({})).toContain("[State]");
    expect(missingLegalSettings({})).toEqual(["NOD_LEGAL_NAME", "NOD_CONTACT_EMAIL", "NOD_LEGAL_STATE", "NOD_LEGAL_UPDATED"]);
  });

  it("fill in the company, contact, law and date", () => {
    const privacy = renderPrivacy(filled);
    const terms = renderTerms(filled);
    expect(privacy).not.toMatch(/\[(Company name|contact email|date)\]/);
    expect(privacy).toContain('<a href="mailto:help@nod.test">help@nod.test</a>');
    expect(terms).toContain("governed by the laws of Massachusetts, USA");
    expect(terms).toContain("Last updated 2026-11-05");
    expect(missingLegalSettings(filled)).toEqual([]);
    expect(legalSettings({ NOD_LEGAL_NAME: " Nod Labs " } as unknown as NodeJS.ProcessEnv).company).toBe("Nod Labs");
  });

  it("say what carriers look for: no sharing numbers for marketing, frequency, rates, STOP and HELP", () => {
    expect(renderPrivacy(filled)).toContain("No mobile information is shared with third parties or affiliates for marketing or promotional purposes.");
    const terms = renderTerms(filled);
    for (const phrase of ["Message frequency varies", "Message and data rates may apply", "Reply STOP", "HELP for help", "isn't a condition of any purchase"]) {
      expect(terms).toContain(phrase);
    }
  });

  it("match what Nod actually keeps", () => {
    const privacy = renderPrivacy(filled);
    expect(privacy).toContain("at most the last 200 messages or 30 days");
    expect(privacy).toContain("@Nod forget this chat");
    expect(privacy).toMatch(/never the chat/);
  });
});

describe("the home page's consent and disclosure", () => {
  it("links the terms and privacy pages from the form, and carries the affiliate disclosure", () => {
    const html = renderLanding({ nodPhone: "+15550100000" });
    expect(html).toMatch(/By tapping Get Nod, you agree to get texts from Nod[\s\S]*Reply STOP to cancel, HELP for help/);
    expect(html).toContain('<a href="/terms">Terms</a>');
    expect(html).toContain('<a href="/privacy">Privacy</a>');
    expect(html).toContain("Nod may earn a commission when you book through its links.");
  });
});
