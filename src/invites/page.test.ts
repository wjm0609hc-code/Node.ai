import { describe, expect, it } from "vitest";
import { renderJoinPage, smsLink } from "./page";

describe("smsLink", () => {
  it("opens Messages to Nod with the code typed in", () => {
    expect(smsLink("+15550100000", "NOD-7K3QXP")).toBe("sms:+15550100000?&body=NOD-7K3QXP");
    expect(smsLink("+15550100000")).toBe("sms:+15550100000");
  });
});

describe("renderJoinPage", () => {
  it("shows the code and a button that texts it to Nod", () => {
    const html = renderJoinPage({ code: "NOD-7K3QXP", nodPhone: "+15550100000" });
    expect(html).toContain("NOD-7K3QXP");
    expect(html).toContain('href="sms:+15550100000?&amp;body=NOD-7K3QXP"');
    expect(html).toContain("(555) 010-0000");
    expect(html).toContain("<title>Join Nod</title>");
  });

  it("without a code, offers a form and the waitlist", () => {
    const html = renderJoinPage({ code: null, nodPhone: "+15550100000" });
    expect(html).toContain('<form method="get" action="/join">');
    expect(html).toMatch(/waitlist/);
    expect(html).toContain('href="sms:+15550100000"');
  });

  it("says when a code isn't valid", () => {
    expect(renderJoinPage({ code: null, invalid: true, nodPhone: "+15550100000" })).toMatch(/doesn't look like an invite code/);
  });

  it("works before Nod's number is configured", () => {
    const html = renderJoinPage({ code: "NOD-7K3QXP", nodPhone: "" });
    expect(html).not.toContain("sms:");
    expect(html).toContain("NOD-7K3QXP");
  });
});
