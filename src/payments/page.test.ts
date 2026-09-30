import { describe, expect, it } from "vitest";
import { renderPayPage, renderPayoutPage, STRIPE_JS } from "./page";

const view = { description: "Casa <Azul>", amountCents: 15000, currency: "USD", payeeName: "Will", groupName: "Tulum", deadline: "Thu, Oct 1, 11:00 AM" };

describe("pay page", () => {
  it("shows the share and loads Stripe's card form when there's something to pay", () => {
    const html = renderPayPage({ ...view, state: "pay" });
    expect(html).toContain("$150");
    expect(html).toContain("Casa &lt;Azul&gt;");
    expect(html).toContain(`<script src="${STRIPE_JS}"></script>`);
    expect(html).not.toContain("<Azul>");
  });

  it.each([
    ["held", /charged only once everyone has paid/],
    ["paid", /Paid/],
    ["closed", /collection is closed/],
    ["waiting", /setting up payouts/],
  ] as const)("shows the %s state without a card form", (state, text) => {
    const html = renderPayPage({ ...view, state });
    expect(html).toMatch(text);
    expect(html).not.toContain(STRIPE_JS);
  });

  it("renders the payout result", () => {
    expect(renderPayoutPage("ready")).toMatch(/You're set up/);
    expect(renderPayoutPage("pending")).toMatch(/still checking/);
  });
});
