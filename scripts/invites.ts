// Admin: invite codes and the waitlist, against the production database and Sendblue.
//   npm run invites -- codes 10     print 10 new single-use codes to hand out
//   npm run invites -- release 25   let the next 25 people in off the waitlist (texts each one)
//   npm run invites -- trips        send post-trip codes now (normally a daily Inngest job)
// Needs the same environment variables as the app (.env.example).
import { getContainer } from "../src/server/container";

const [command, arg] = process.argv.slice(2);
const count = Number(arg ?? "1");
if (!["codes", "release", "trips"].includes(command ?? "") || !Number.isInteger(count) || count < 1 || count > 500) {
  console.error("usage: npm run invites -- codes <n> | release <n> | trips   (n from 1 to 500)");
  process.exit(1);
}
const { nod } = await getContainer();
if (command === "codes") for (const code of await nod.invites.createCodes(count)) console.log(code);
if (command === "release") console.log(`Let in ${await nod.invites.releaseWaitlist(count)} people.`);
if (command === "trips") console.log(`Sent ${await nod.invites.sweepTrips()} post-trip codes.`);
process.exit(0);
