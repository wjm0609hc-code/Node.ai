// Terminal chat simulator. `npm run sim` (optionally `npm run sim -- tulum` or `-- mixed`).
// You play every person; "nod>" lines show exactly what Nod's provider receives,
// and "→" lines show what the real inbound pipeline decided (stored in an
// in-memory Postgres). Set ANTHROPIC_API_KEY to let Claude answer and judge ambiguous "nod"s.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DrizzleStore, type Store } from "../../db/store";
import { createTestDb } from "../../db/testing";
import { createResponder } from "../../agent/responder";
import { createClaudeAnswerClassifier } from "../../detection/answer-classifier";
import { createClaudeClassifier } from "../../detection/classifier";
import type { InboundResult } from "../../inbound/pipeline";
import { silentLogger } from "../../lib/log";
import { createNod, type Nod } from "../../nod";
import { MemoryScheduler } from "../../jobs/scheduler";
import { webListingFetcher } from "../../rentals/fetch";
import { sampleListingFetcher } from "../../rentals/samples";
import { createClaudeSearcher } from "../../search/claude-searcher";
import { createSamplePartner } from "../../booking/sample-partner";
import { sampleSearcher } from "../../search/samples";
import type {
  CreateGroupRequest,
  Destination,
  InboundEvent,
  InboundHandler,
  MessagingProvider,
  OutboundContent,
  Tapback,
} from "../types";
import { seedMixedGroup, seedTulumGroup } from "./scenarios";
import { ChatWorld, type Platform, type TranscriptLine } from "./world";

const world = new ChatWorld();
let app: Nod;
let store: Store;
const scheduler = new MemoryScheduler();
const registered = new Set<string>();
let me: string | undefined; // user id
let chat: string | "dm" | undefined; // group id or "dm"

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** Prints everything Nod sends, then passes it to the simulator. */
class ShowingProvider implements MessagingProvider {
  readonly name: string;
  readonly selfPhone: string;
  constructor(private readonly inner: MessagingProvider) {
    this.name = inner.name;
    this.selfPhone = inner.selfPhone;
  }
  onInbound(h: InboundHandler) {
    return this.inner.onInbound(h);
  }
  async send(to: Destination, content: OutboundContent) {
    const where = "groupId" in to ? `[${to.groupId}]` : `[private to ${world.userByPhone(to.phone)?.name ?? to.phone}]`;
    console.log(yellow(`  Nod ${where}: ${describeContent(content)}`));
    return this.inner.send(to, content);
  }
  async createGroup(req: CreateGroupRequest) {
    const res = await this.inner.createGroup(req);
    const names = req.members.map((p) => world.userByPhone(p)?.name ?? p).join(", ");
    console.log(yellow(`  Nod started ${res.groupId} "${req.name ?? ""}" (${res.service}) with ${names}: ${describeContent(req.firstMessage)}`));
    return res;
  }
}

function describeContent(c: OutboundContent): string {
  const extras = [c.contactCard ? "contact card" : "", ...(c.mediaUrls ?? []).map((u) => `media ${u}`)].filter(Boolean);
  return `${c.text ?? ""}${extras.length ? dim(` [${extras.join(", ")}]`) : ""}`;
}

async function startNod() {
  store = new DrizzleStore(await createTestDb());
  const classify = process.env.ANTHROPIC_API_KEY
    ? createClaudeClassifier()
    : async () => {
        console.log(dim("  (ambiguous; no ANTHROPIC_API_KEY set, so treating it as not addressed)"));
        return false;
      };
  app = createNod({
    store,
    provider: new ShowingProvider(world.provider()),
    classify,
    ...(process.env.ANTHROPIC_API_KEY ? { classifyAnswer: createClaudeAnswerClassifier() } : {}),
    logger: silentLogger,
    scheduler,
    config: { howToVideoUrl: "https://nod.example/add-nod.mp4", logoUrl: "https://nod.example/nod-logo.png" },
    // Real pages and searches by default; NOD_SAMPLES=1 uses the web simulator's samples instead.
    fetchListing: process.env.NOD_SAMPLES ? sampleListingFetcher : webListingFetcher,
    searcher: process.env.NOD_SAMPLES || !process.env.ANTHROPIC_API_KEY ? sampleSearcher : createClaudeSearcher(),
    // No real booking partners yet, so Nod books through the labelled sample partner here.
    bookingPartners: [createSamplePartner()],
    makeResponder: process.env.ANTHROPIC_API_KEY
      ? (env) => createResponder(env)
      : () => async () => console.log(dim("    (Claude would answer here; set ANTHROPIC_API_KEY to hear it)")),
  });
  world.provider().onInbound(async (e) => {
    console.log(cyan(`  nod> ${describe(e)}`));
    console.log(verdict(await app.handle(e)));
  });
}

/** New people start with access and a known name, as if they'd onboarded. */
async function registerNewPeople() {
  for (const u of world.allUsers()) {
    if (registered.has(u.id)) continue;
    const row = await store.upsertUser(u.phone);
    await store.setUserName(row.id, u.name);
    await store.setUserAccess(row.id, "active");
    registered.add(u.id);
  }
}

function verdict(r: InboundResult): string {
  switch (r.status) {
    case "stored": {
      const seen = r.firstSeenGroup ? " · first message from this group" : "";
      return r.addressed ? green(`    → addressed to Nod (${r.reason})${seen}`) : dim(`    → stays silent (${r.reason})${seen}`);
    }
    case "reaction":
      return dim(r.stored ? "    → tapback saved on that message" : "    → tapback on a message Nod never saw; ignored");
    case "membership":
      if (r.nodAdded) return green("    → Nod joined and recorded who added it");
      return dim(r.nodRemoved ? "    → Nod was removed" : "    → membership updated");
    case "duplicate":
      return dim("    → duplicate delivery; ignored");
    case "ignored":
      return dim("    → Nod's own message; ignored");
  }
}

function describe(e: InboundEvent): string {
  const who = (p: string) => world.userByPhone(p)?.name ?? p;
  switch (e.type) {
    case "message": {
      const where = e.groupId ? `[${e.groupId} ${e.service}]` : `[private ${e.service}]`;
      const extras = [
        e.mentions.length ? "mention" : "",
        e.replyToMessageId ? `reply→${e.replyToMessageId}` : "",
        e.mediaUrls.length ? `${e.mediaUrls.length} media` : "",
      ].filter(Boolean);
      return `${where} ${e.messageId} ${who(e.from)}: ${e.text}${extras.length ? dim(` (${extras.join(", ")})`) : ""}`;
    }
    case "reaction":
      return `[${e.groupId}] ${who(e.from)} ${e.removed ? "removed" : "sent"} ${e.reaction} on ${e.targetMessageId}`;
    case "participant_added":
      return `[${e.groupId}] added to "${e.groupName ?? ""}" by ${who(e.addedBy)} (${e.members.length} members, ${e.service})`;
    case "participant_removed":
      return `[${e.groupId}] removed by ${who(e.removedBy)}`;
  }
}

function printLine(l: TranscriptLine) {
  if (l.kind === "system") return console.log(dim(`  ${l.messageId}  — ${l.text}`));
  const reply = l.replyToMessageId ? dim(` ↪${l.replyToMessageId}`) : "";
  const extra = [...l.mediaUrls, ...(l.contactCard ? [`[contact card: ${l.contactCard.name}]`] : [])];
  console.log(`  ${dim(l.messageId)}  ${l.fromName}:${reply} ${l.text}${extra.length ? " " + dim(extra.join(" ")) : ""}`);
}

/** Scenarios can repeat names, so prefer you, then people in the current chat, then anyone. */
function findUser(name: string) {
  const matches = world.allUsers().filter((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
  const here = chat && chat !== "dm" ? new Set(world.allGroups().find((g) => g.id === chat)?.members) : new Set<string>();
  const u = matches.find((x) => x.id === me) ?? matches.find((x) => here.has(x.id)) ?? matches.at(-1);
  if (!u) throw new Error(`no user "${name}" (try /users)`);
  return u;
}

function findGroup(key: string) {
  const g = world.allGroups().find((x) => x.id === key || x.name?.toLowerCase().startsWith(key.toLowerCase()));
  if (!g) throw new Error(`no group "${key}" (try /groups)`);
  return g;
}

function need<T>(v: T | undefined, msg: string): T {
  if (v === undefined) throw new Error(msg);
  return v;
}

const HELP = `
  /scenario tulum|mixed      seed a group with prior history
  /user <name> iphone|android
  /group <name> <a,b,c>      new group started by you
  /users  /groups
  /as <name>                 switch who you are
  /in <group>|dm             switch chat (dm = private thread with Nod)
  <text>                     send as yourself ("@Nod" in iMessage becomes a real mention)
  /reply <msgId> <text>      inline reply
  /react <msgId> love|like|dislike|laugh|emphasize|question
  /addnod  /removenod        add or remove Nod (Apple's rules apply)
  /share <name>[,name]       share contact cards into the current chat
  /access <name> on|off      give or take away someone's access (everyone starts with it)
  /deadline                  fast-forward: run pending vote nudges and deadlines now
  /nod <text>                send as Nod into the current chat
  /log [nod]                 transcript as you (or as Nod)
  /quit`;

async function handle(input: string) {
  const [cmd, ...rest] = input.split(" ");
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/help":
      return console.log(HELP);
    case "/scenario": {
      const s = arg === "mixed" ? seedMixedGroup(world) : seedTulumGroup(world);
      me = Object.values(s.users)[0]!.id;
      chat = s.groupId;
      console.log(dim(`  seeded ${s.groupId}; you are ${world.user(me).name}`));
      return world.transcript(chat, me).forEach(printLine);
    }
    case "/user": {
      const [name, platform = "iphone"] = rest;
      const u = world.addUser({ name: need(name, "usage: /user <name> iphone|android"), platform: platform as Platform });
      me ??= u.id;
      return console.log(dim(`  ${u.name} ${u.phone} (${u.platform})`));
    }
    case "/users":
      return world.allUsers().forEach((u) => console.log(`  ${u.id} ${u.name} ${u.phone} ${u.platform}`));
    case "/groups":
      return world
        .allGroups()
        .forEach((g) => console.log(`  ${g.id} "${g.name ?? ""}" ${g.service} ${g.members.length} members${g.hasNod ? " +Nod" : ""}`));
    case "/group": {
      const name = need(rest[0], "usage: /group <name> <a,b,c>");
      const members = (rest[1] ?? "").split(",").filter(Boolean).map((n) => findUser(n).id);
      chat = world.createGroup({ name, createdBy: need(me, "pick a user with /as"), members });
      return console.log(dim(`  created ${chat} (${world.groupService(chat)})`));
    }
    case "/as":
      me = findUser(arg).id;
      return console.log(dim(`  you are ${world.user(me).name}`));
    case "/in":
      chat = arg === "dm" ? "dm" : findGroup(arg).id;
      return;
    case "/addnod": {
      const r = world.addNod(groupChat(), need(me, "pick a user with /as"));
      if (!r.ok) console.log(dim(`  can't add Nod: ${r.reason}`));
      return;
    }
    case "/removenod":
      return world.removeNod(groupChat(), need(me, "pick a user with /as"));
    case "/react": {
      const [id, tapback] = rest;
      world.react(need(me, "pick a user with /as"), need(id, "usage: /react <msgId> <tapback>"), (tapback ?? "like") as Tapback);
      return;
    }
    case "/reply": {
      const [id, ...text] = rest;
      world.say(need(me, "pick a user with /as"), groupChat(), text.join(" "), {
        replyTo: need(id, "usage: /reply <msgId> <text>"),
        mentionNod: /@nod\b/i.test(text.join(" ")),
      });
      return;
    }
    case "/share": {
      const cards = arg.split(",").map((n) => findUser(n.trim())).map((u) => ({ name: u.name, phone: u.phone }));
      const user = need(me, "pick a user with /as");
      if (chat === "dm") world.dm(user, "", { contactCards: cards });
      else world.say(user, groupChat(), "", { contactCards: cards });
      return;
    }
    case "/deadline": {
      // Fast-forward: run every pending vote nudge and deadline now.
      const due = scheduler.pending().length;
      await scheduler.runDue(new Date(8.64e15), app.runJob);
      return console.log(dim(`  ran ${due} scheduled vote job${due === 1 ? "" : "s"}`));
    }
    case "/access": {
      const [name, onOff = "on"] = rest;
      const u = findUser(need(name, "usage: /access <name> on|off"));
      await store.setUserAccess((await store.upsertUser(u.phone)).id, onOff === "off" ? "waitlist" : "active");
      return console.log(dim(`  ${u.name} ${onOff === "off" ? "no longer has" : "has"} access`));
    }
    case "/nod": {
      if (chat === "dm") await app.provider.send({ phone: world.user(need(me, "pick a user")).phone }, { text: arg });
      else await app.provider.send({ groupId: groupChat() }, { text: arg });
      return;
    }
    case "/log": {
      if (chat === "dm") return world.dmTranscript(need(me, "pick a user")).forEach(printLine);
      return world.transcript(groupChat(), arg === "nod" ? "nod" : need(me, "pick a user")).forEach(printLine);
    }
    default: {
      if (input.startsWith("/")) throw new Error(`unknown command ${cmd} (try /help)`);
      const user = need(me, "create or pick a user first (/user, /as, or /scenario tulum)");
      if (chat === "dm") world.dm(user, input);
      else world.say(user, groupChat(), input, { mentionNod: /@nod\b/i.test(input) });
    }
  }
}

function groupChat(): string {
  if (!chat || chat === "dm") throw new Error("switch to a group with /in <group>");
  return chat;
}

async function main() {
  console.log("Nod chat simulator. /help for commands.");
  await startNod();
  setInterval(() => void scheduler.runDue(new Date(), app.runJob), 30_000).unref();
  const preset = process.argv[2];
  if (preset) await handle(`/scenario ${preset}`);
  await registerNewPeople();
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  const prompt = () => {
    rl.setPrompt(`${me ? world.user(me).name : "?"}@${chat === "dm" ? "private" : (chat ?? "-")}> `);
    rl.prompt();
  };
  prompt();
  for await (const raw of rl) {
    const input = raw.trim();
    if (input === "/quit") break;
    if (input) {
      if (!stdin.isTTY) console.log(input);
      try {
        await handle(input);
        await registerNewPeople();
        await world.settled();
      } catch (err) {
        console.log(dim(`  ${(err as Error).message}`));
      }
    }
    prompt();
  }
  rl.close();
}

main();
