import { describe, expect, it } from "vitest";
import { renderLanding } from "./landing";
import { nodIconSvg, nodWordmarkSvg } from "./logo";

describe("renderLanding", () => {
  const html = renderLanding({ nodPhone: "+15550100000", appUrl: "https://nod.example/" });

  it("signs people up by text: the button opens Messages to Nod", () => {
    expect(html).toContain('href="sms:+15550100000?&amp;body=Hey%20Nod"');
  });

  it("links invite codes to /join and invites to a private text", () => {
    expect(html).toContain('href="/join">Have an invite code?');
    expect(html).toMatch(/href="sms:\+15550100000\?&amp;body=Give%20me%20an%20invite[^"]*">Invite a friend/);
  });

  it("collects nothing on the page", () => {
    expect(html).not.toMatch(/<form|<input/);
  });

  it("can be indexed and has a link preview", () => {
    expect(html).not.toContain("noindex");
    expect(html).toContain("<title>Nod</title>");
    expect(html).toContain('<meta property="og:image" content="https://nod.example/nod-logo.png">');
  });

  it("falls back to /join before Nod has a number", () => {
    const bare = renderLanding({ nodPhone: "" });
    expect(bare).not.toContain("sms:");
    expect(bare).toContain('href="/join">Text Nod to get started');
    expect(bare).not.toContain("og:image");
  });
});

describe("logo", () => {
  it("is labelled when a title is given and hidden otherwise", () => {
    expect(nodWordmarkSvg({ title: "Nod" })).toContain('aria-label="Nod"');
    expect(nodWordmarkSvg()).toContain('aria-hidden="true"');
    expect(nodWordmarkSvg({ height: 64 })).toContain('width="102" height="64"');
  });

  it("draws the icon at the size asked", () => {
    expect(nodIconSvg(256)).toContain('width="256" height="256"');
  });
});
