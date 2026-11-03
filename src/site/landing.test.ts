import { describe, expect, it } from "vitest";
import { greeting, renderLanding } from "./landing";
import { introducedName } from "../invites/names";
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

  it("sends nothing anywhere: no form, and the name field only shapes the text", () => {
    expect(html).not.toMatch(/<form|fetch\(|XMLHttpRequest|sendBeacon/);
    expect(html).toContain('id="name"');
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

describe("greeting", () => {
  it("types a greeting Nod can read the name back from", () => {
    for (const [typed, name] of [["Will", "Will"], ["  will smith ", "Will"], ["jo-anne", "Jo-Anne"], ["Zoë", "Zoë"]] as const) {
      const g = greeting(typed);
      expect(introducedName(g)).toBe(name === "Jo-Anne" ? "Jo-anne" : name);
    }
  });

  it("is a plain hello without a name", () => {
    expect(greeting("")).toBe("Hey Nod");
    expect(greeting("  <>  ")).toBe("Hey Nod");
  });

  it("keeps the button's link in step with the name field in the browser", () => {
    const html = renderLanding({ nodPhone: "+15550100000" });
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    const handlers: Record<string, (e?: unknown) => void> = {};
    const input = { value: "", addEventListener: (k: string, f: (e?: unknown) => void) => (handlers[k] = f) };
    const button = { href: "", click: () => {} };
    new Function("document", script)({ getElementById: (id: string) => (id === "name" ? input : button) });
    input.value = "will";
    handlers.input!();
    expect(button.href).toBe(`sms:+15550100000?&body=${encodeURIComponent("Hey Nod! I'm Will.")}`);
    input.value = "";
    handlers.input!();
    expect(button.href).toBe("sms:+15550100000?&body=Hey%20Nod");
  });
});
