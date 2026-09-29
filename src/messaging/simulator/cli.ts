// Terminal chat simulator. `npm run sim` (optionally `npm run sim -- tulum` or `-- mixed`).
// You play every person; "nod>" lines show exactly what Nod's provider receives.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { InboundEvent, Tapback } from "../types";
import { seedMixedGroup, seedTulumGroup } from "./scenarios";
import { ChatWorld, type Platform, type TranscriptLine } from "./world";

const world = new ChatWorld();
const nod = world.provider();
let me: string | undefined; // user id
let chat: string | "dm" | undefined; // group id or "dm"

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

nod.onInbound((e) => console.log(cyan(`  nod> ${describe(e)}`)));

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

function findUser(name: string) {
  const u = world.allUsers().find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
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
    case "/nod": {
      if (chat === "dm") await nod.send({ phone: world.user(need(me, "pick a user")).phone }, { text: arg });
      else await nod.send({ groupId: groupChat() }, { text: arg });
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
  const preset = process.argv[2];
  if (preset) await handle(`/scenario ${preset}`);
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
