// The private pay page (/pay/[token]) and the payout setup result page. The pay
// page shows only this person's share; card entry is Stripe's Payment Element,
// so card details never touch Nod's servers.

import { money } from "../booking/shared";
import type { PayPageView } from "./payments";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Stripe.js for API version 2026-08-26.dahlia (the URL @stripe/stripe-js loads). */
export const STRIPE_JS = "https://js.stripe.com/dahlia/stripe.js";

const STYLE = `:root{--bg:#f6f6f3;--fg:#17181b;--muted:#63666d;--line:#dedfda;--accent:#a8520a;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--fg:#ecedef;--muted:#9a9ea6;--line:#2b2d31;--accent:#f0a04a;--card:#1b1c1f}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:480px;margin:0 auto;padding:28px 16px 48px}
h1{font-size:22px;margin:0 0 2px}.sub{color:var(--muted);margin:0 0 20px;font-size:14px}
.amount{font-size:36px;font-weight:700;margin:8px 0 4px}
.box{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
button{width:100%;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:0;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.6}.note{color:var(--muted);font-size:14px}#error{color:#c0392b;font-size:14px;min-height:1.2em}`;

function shell(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style>${head}</head><body><main>${body}</main></body></html>`;
}

const STATE_TEXT: Record<Exclude<PayPageView["state"], "pay">, string> = {
  held: "Your card is held. It's charged only once everyone has paid, and released if they don't in time. You can close this page.",
  paid: "Paid. Thanks!",
  closed: "This collection is closed, and your card wasn't charged.",
  waiting: "Almost ready: the person collecting is still setting up payouts. Nod will text you when you can pay.",
};

export function renderPayPage(v: PayPageView): string {
  const header = `<h1>${esc(v.description)}</h1><p class="sub">${esc(v.groupName)} · to ${esc(v.payeeName)} · due ${esc(v.deadline)}</p>
<div class="amount">${esc(money(v.amountCents, v.currency))}</div>`;
  if (v.state !== "pay") return shell(`Nod: ${v.description}`, `${header}<div class="box"><p>${esc(STATE_TEXT[v.state])}</p></div>`);
  const body = `${header}
<p class="note">Your card is only held now. Everyone's card is charged together once the whole group has paid; if they don't by the deadline, the hold is released.</p>
<form id="pay" class="box"><div id="element"></div><p id="error" role="alert"></p><button id="submit" type="submit" disabled>Hold ${esc(money(v.amountCents, v.currency))}</button></form>
<p class="note">Payments are processed by Stripe and go straight to ${esc(v.payeeName)}. Nod never sees your card number.</p>
<script>
(async () => {
  const err = document.getElementById("error"), btn = document.getElementById("submit");
  const res = await fetch(location.pathname, { method: "POST" });
  const data = await res.json();
  if (!data.clientSecret) { location.reload(); return; }
  const stripe = Stripe(data.publishableKey, { stripeAccount: data.accountId });
  const elements = stripe.elements({ clientSecret: data.clientSecret });
  elements.create("payment").mount("#element");
  btn.disabled = false;
  document.getElementById("pay").addEventListener("submit", async (e) => {
    e.preventDefault(); btn.disabled = true; err.textContent = "";
    const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: location.origin + location.pathname } });
    if (error) { err.textContent = error.message || "That didn't go through. Try again."; btn.disabled = false; }
  });
})().catch(() => { document.getElementById("error").textContent = "Something went wrong loading the payment form. Refresh to try again."; });
</script>`;
  return shell(`Nod: ${v.description}`, body, `<script src="${STRIPE_JS}"></script>`);
}

export function renderPayoutPage(state: "ready" | "pending"): string {
  return shell(
    "Nod payouts",
    state === "ready"
      ? `<h1>You're set up</h1><p>Payouts are ready. Nod has sent everyone their pay link; head back to your chat.</p>`
      : `<h1>Almost there</h1><p class="note">Stripe is still checking your details. Nod will text the group once you're ready. <a href="?">Continue setup</a></p>`,
  );
}

export function notFoundPage(): string {
  return shell("Nod", `<h1>Link not found</h1><p class="note">This link isn't valid. Ask Nod in your chat to send it again.</p>`);
}
