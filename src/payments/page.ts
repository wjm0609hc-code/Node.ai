// The private pay page (/pay/[token]) and the payout setup result page. The pay
// page shows only this person's share; card entry is Stripe's Payment Element,
// so card details never touch Nod's servers.

import { money } from "../booking/shared";
import { cardHtml, esc, statusHtml, webPage } from "../web/theme";
import type { PayPageView } from "./payments";

/** Stripe.js for API version 2026-08-26.dahlia (the URL @stripe/stripe-js loads). */
export const STRIPE_JS = "https://js.stripe.com/dahlia/stripe.js";

const STATE: Record<Exclude<PayPageView["state"], "pay">, { kind: "done" | "wait" | "off"; title: string; text: string }> = {
  held: { kind: "done", title: "Your card is held", text: "It's charged only once everyone has paid, and released if they don't in time. You can close this page." },
  paid: { kind: "done", title: "Paid. Thanks!", text: "You're all set. You can close this page." },
  closed: { kind: "off", title: "This collection is closed", text: "Your card wasn't charged." },
  waiting: { kind: "wait", title: "Almost ready", text: "The person collecting is still setting up payouts. Nod will text you when you can pay." },
};

function shareCard(v: PayPageView): string {
  return cardHtml({ glyph: "$", short: true, source: `Pay ${v.payeeName} · ${v.groupName}`, name: v.description, price: money(v.amountCents, v.currency), footer: `Due ${v.deadline}` });
}

export function renderPayPage(v: PayPageView): string {
  const title = `Pay ${v.payeeName}: ${v.description}`;
  if (v.state !== "pay") {
    const st = STATE[v.state];
    return webPage({ title, body: `${shareCard(v)}${statusHtml(st.kind, st.title, st.text)}` });
  }
  const amount = money(v.amountCents, v.currency);
  const body = `${shareCard(v)}
<form id="pay" class="sheet"><div id="element"></div><p id="error" class="error" role="alert"></p><button id="submit" class="btn" type="submit" disabled>Hold ${esc(amount)}</button></form>
<p class="note">Your card is only held now. Everyone is charged together once the whole group has paid; if they don't by the deadline, the hold is released. Payments go through Stripe straight to ${esc(v.payeeName)}; Nod never sees your card number.</p>
<script>
(async () => {
  const err = document.getElementById("error"), btn = document.getElementById("submit");
  const res = await fetch(location.pathname, { method: "POST" });
  const data = await res.json();
  if (!data.clientSecret) { location.reload(); return; }
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const stripe = Stripe(data.publishableKey, { stripeAccount: data.accountId });
  const elements = stripe.elements({
    clientSecret: data.clientSecret,
    appearance: {
      theme: dark ? "night" : "stripe",
      variables: { colorPrimary: dark ? "#f2f2f7" : "#1c1c1e", borderRadius: "12px", fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif", fontSizeBase: "16px" },
    },
  });
  elements.create("payment", { layout: "tabs" }).mount("#element");
  btn.disabled = false;
  document.getElementById("pay").addEventListener("submit", async (e) => {
    e.preventDefault(); btn.disabled = true; err.textContent = "";
    const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: location.origin + location.pathname } });
    if (error) { err.textContent = error.message || "That didn't go through. Try again."; btn.disabled = false; }
  });
})().catch(() => { document.getElementById("error").textContent = "The payment form didn't load. Refresh to try again."; });
</script>`;
  return webPage({ title, body, head: `<script src="${STRIPE_JS}"></script>` });
}

export function renderPayoutPage(state: "ready" | "pending"): string {
  return webPage({
    title: "Nod payouts",
    body:
      state === "ready"
        ? `<h1>You're set up</h1>${statusHtml("done", "Payouts are ready", "Nod has sent everyone their pay link. Head back to your chat.")}`
        : `<h1>Almost there</h1>${statusHtml("wait", "Stripe is still checking your details", "Nod will text the group once you're ready.")}<a class="btn" href="?">Continue setup</a>`,
  });
}

export function notFoundPage(): string {
  return webPage({ title: "Nod", body: `<h1>Link not found</h1><p class="sub">This link isn't valid. Ask Nod in your chat to send it again.</p>` });
}
