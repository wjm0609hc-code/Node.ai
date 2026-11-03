import { describe, expect, it } from "vitest";
import { renderLanding, renderSignupDone } from "./landing";
import { nodIconSvg, nodWordmarkSvg } from "./logo";

describe("renderLanding", () => {
  const html = renderLanding({ nodPhone: "+15550100000", appUrl: "https://nod.example/" });

  it("signs people up with a name and number posted to /signup", () => {
    expect(html).toContain('<form class="join" id="signup" method="post" action="/signup">');
    expect(html).toMatch(/<input class="field" name="name"/);
    expect(html).toMatch(/<input class="field" name="phone" type="tel"[^>]* required/);
    expect(html).toContain('name="website"'); // the hidden field bots fill in
    expect(html).toMatch(/Reply STOP anytime/);
  });

  it("still lets people text Nod, enter a code or invite a friend", () => {
    expect(html).toContain('href="sms:+15550100000?&amp;body=Hey%20Nod">Or just text Nod');
    expect(html).toContain('href="/join">Have an invite code?');
    expect(html).toMatch(/href="sms:\+15550100000\?&amp;body=Give%20me%20an%20invite[^"]*">Invite a friend/);
  });

  it("can be indexed and has a link preview", () => {
    expect(html).not.toContain("noindex");
    expect(html).toContain("<title>Nod</title>");
    expect(html).toContain('<meta property="og:image" content="https://nod.example/nod-logo.png">');
  });

  it("keeps what people typed and shows the problem after a failed sign-up", () => {
    const again = renderLanding({ nodPhone: "", error: "That number doesn't look right.", values: { name: "Will", phone: "555<>" } });
    expect(again).toContain('role="alert">That number doesn&#39;t look right.');
    expect(again).toContain('value="555&lt;&gt;"');
    expect(again).not.toContain("sms:");
  });
});

describe("renderSignupDone", () => {
  it("says to check texts, with the number", () => {
    const html = renderSignupDone({ nodPhone: "+15550100000", status: "sent", phone: "+16175550123" });
    expect(html).toContain("Check your texts.");
    expect(html).toContain("(617) 555-0123");
    expect(html).toContain("noindex");
  });

  it("asks people to come back when the limits are hit", () => {
    expect(renderSignupDone({ nodPhone: "+15550100000", status: "busy" })).toMatch(/Lots of sign-ups right now/);
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
