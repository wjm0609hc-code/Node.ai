// Registers Nod's inbound webhook with Sendblue (POST /api/account/webhooks, type "receive",
// as defined in Sendblue's official SDK). Safe to run again: it skips a URL that's already there.
//   npm run sendblue:webhook
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) {
    console.error(`Set ${k} first (see .env.example).`);
    process.exit(1);
  }
  return v;
};
const appUrl = need("NOD_APP_URL").replace(/\/$/, "");
const secret = need("SENDBLUE_WEBHOOK_SECRET");
const fromNumber = need("SENDBLUE_FROM_NUMBER");
const headers = { "content-type": "application/json", "sb-api-key-id": need("SENDBLUE_API_KEY_ID"), "sb-api-secret-key": need("SENDBLUE_API_SECRET_KEY") };
const url = `${appUrl}/api/inbound?token=${encodeURIComponent(secret)}`;
const api = "https://api.sendblue.co/api/account/webhooks";

const list = await fetch(api, { headers, signal: AbortSignal.timeout(15_000) });
if (!list.ok) {
  console.error(`Sendblue said ${list.status} when listing webhooks: ${await list.text()}`);
  process.exit(1);
}
const current = ((await list.json()) as { webhooks?: { receive?: Array<string | { url: string }> } }).webhooks?.receive ?? [];
const base = `${appUrl}/api/inbound`;
if (current.some((w) => (typeof w === "string" ? w : w.url).startsWith(base))) {
  console.log("Nod's receive webhook is already registered.");
  process.exit(0);
}
const res = await fetch(api, {
  method: "POST",
  headers,
  body: JSON.stringify({ type: "receive", webhooks: [{ url, secret, sendblue_numbers: [fromNumber] }] }),
  signal: AbortSignal.timeout(15_000),
});
if (!res.ok) {
  console.error(`Sendblue said ${res.status}: ${await res.text()}`);
  process.exit(1);
}
console.log(`Registered ${base} for ${fromNumber}.`);
