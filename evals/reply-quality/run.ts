// Runs the reply-quality tests: each case is played through the real Nod app (same system prompt,
// tools, classifiers and Claude model as production), on an in-memory database and the chat
// simulator, with fixed search results. Every graded step gets the automatic checks and the Claude
// grader. Real Claude calls, so it needs ANTHROPIC_API_KEY and costs money (see README.md).
//
//   npm run eval                       # every case once, into .claude/hillclimb/reply-quality/baseline/
//   npm run eval -- --only receipt-split,search-dinner --reps 2
//   npm run eval -- --variant v1       # after changing Nod's prompt or tools, to compare
//
// Results resume: rerunning skips (case, rep) pairs already in results.jsonl.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentClient } from "../../src/agent/responder";
import { createResponder } from "../../src/agent/responder";
import { MemoryStore } from "../../src/db/memory-store";
import { createClaudeAnswerClassifier } from "../../src/detection/answer-classifier";
import { createClaudeClassifier } from "../../src/detection/classifier";
import { MemoryScheduler } from "../../src/jobs/scheduler";
import { silentLogger } from "../../src/lib/log";
import { ChatWorld } from "../../src/messaging/simulator/world";
import { createNod } from "../../src/nod";
import { sampleReceiptReader } from "../../src/tab/receipts";
import { CASES, type Case, type Who } from "./cases";
import { checkStep, type CheckResult } from "./checks";
import { fixtureSearcher, PAST_DINNER } from "./fixtures";
import { createJudge, JUDGE_MODEL, type Criterion } from "./judge";

const FLOW_DIR = path.resolve(".claude/hillclimb/reply-quality");
const APP_URL = "https://get-nod.app";
const NAMES: Record<Who, string> = { will: "Will", sarah: "Sarah", jake: "Jake", mike: "Mike", priya: "Priya" };
// Wednesday Nov 11, 2026, 5pm in New York: "Saturday" and "tonight" always mean the same days.
const START = new Date("2026-11-11T22:00:00Z").getTime();

function args() {
  const a = process.argv.slice(2);
  const val = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    variant: val("--variant") ?? "baseline",
    reps: Number(val("--reps") ?? 1),
    only: val("--only")?.split(",").map((s) => s.trim()),
    concurrency: Number(val("--concurrency") ?? 4),
    timeoutS: Number(val("--timeout-s") ?? 300),
    judge: !a.includes("--no-judge"),
  };
}

/** Records every Claude call Nod's responder makes, so the runner can see tools, text and usage. */
function recordingClient(real: Anthropic) {
  const calls: Array<{ request: any; response: Anthropic.Beta.BetaMessage }> = [];
  const client = {
    beta: {
      messages: {
        create: async (body: any, opts?: any) => {
          const response = (await real.beta.messages.create(body, opts)) as Anthropic.Beta.BetaMessage;
          calls.push({ request: body, response });
          return response;
        },
      },
    },
  } as unknown as AgentClient;
  return { client, calls };
}

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
const zero = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
function addUsage(t: Usage, u: Partial<Usage> | null | undefined) {
  if (!u) return;
  t.input_tokens += u.input_tokens ?? 0;
  t.output_tokens += u.output_tokens ?? 0;
  t.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  t.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
}

export interface RunDeps {
  /** Nod's Claude client (the real one by default; tests pass a scripted one). */
  anthropic?: Pick<Anthropic, "beta">;
  classify?: Parameters<typeof createNod>[0]["classify"];
  classifyAnswer?: Parameters<typeof createNod>[0]["classifyAnswer"];
}

export async function runCase(c: Case, rep: number, judge: ReturnType<typeof createJudge> | undefined, deps: RunDeps = {}) {
  const started = Date.now();
  let clock = START - 30 * 86_400_000;
  const now = () => new Date(clock);
  const world = new ChatWorld({ now });
  const store = new MemoryStore({ now });
  const rec = recordingClient((deps.anthropic ?? new Anthropic({ maxRetries: 4 })) as Anthropic);
  const nod = createNod({
    store,
    provider: world.provider(),
    classify: deps.classify ?? createClaudeClassifier(),
    classifyAnswer: deps.classifyAnswer ?? createClaudeAnswerClassifier(),
    logger: silentLogger,
    scheduler: new MemoryScheduler(),
    config: { howToVideoUrl: `${APP_URL}/add-nod.mp4`, logoUrl: `${APP_URL}/nod-logo.png`, appUrl: APP_URL, timezone: "America/New_York" },
    searcher: fixtureSearcher,
    receiptReader: sampleReceiptReader,
    now,
    makeResponder: (env) => createResponder({ ...env, client: rec.client }),
  });
  world.provider().onInbound((e) => nod.handle(e).then(() => {}));

  // The group, with Nod added a month ago.
  const who = c.group === "tulum" ? (["will", "jake", "sarah", "mike"] as Who[]) : (["will", "sarah", "jake", "mike", "priya"] as Who[]);
  const users = Object.fromEntries(who.map((w) => [w, world.addUser({ name: NAMES[w], platform: "iphone" })])) as Record<Who, ReturnType<ChatWorld["addUser"]>>;
  const groupId = world.createGroup({ name: c.group === "tulum" ? "Tulum 🌴" : "Dinner club", createdBy: users.will.id, members: who.map((w) => users[w].id) });
  for (const w of who) {
    const row = await store.upsertUser(users[w].phone);
    if (!(w === "mike" && c.seed?.includes("mike_unnamed"))) await store.setUserName(row.id, NAMES[w]);
    await store.setUserAccess(row.id, "active");
  }
  world.addNod(groupId, users.will.id);
  await world.settled();
  const group = (await store.groupByProviderId("simulator", groupId))!;
  const userId = async (w: Who) => (await store.upsertUser(users[w].phone)).id;

  if (c.seed?.includes("mike_vegetarian")) {
    await store.createGroupNote({ groupId: group.id, subjectUserId: await userId("mike"), note: "vegetarian", kind: "must_have", createdByUserId: await userId("mike") });
  }
  if (c.seed?.includes("past_dinner")) {
    clock = START - PAST_DINNER.daysAgo * 86_400_000;
    const { option } = await store.upsertOption({ groupId: group.id, kind: "restaurant", source: "search", url: PAST_DINNER.url, postedByUserId: null, providerMessageId: null });
    await store.updateOptionParsed(option.id, { title: PAST_DINNER.title, area: PAST_DINNER.area, bookingUrl: PAST_DINNER.url });
    const b = await store.createBooking({ groupId: group.id, optionId: option.id, decisionId: null, requestedByUserId: await userId("sarah"), partySize: PAST_DINNER.partySize, startsAt: new Date(clock + 3 * 3_600_000), endsAt: null, allDay: false, link: PAST_DINNER.url, method: "link" });
    await store.updateBooking(b.id, { status: "booked" });
  }
  clock = START;

  const viewer = users.will.id;
  const chat: string[] = [];
  const trace: any[] = [];
  const checks: CheckResult[] = [];
  const judged: Array<Record<Criterion, boolean>> = [];
  const explanations: string[] = [];
  const usage = zero();
  const judgeUsage = zero();
  let toolCalls = 0;
  let lastStop: string | null = null;
  let servedModel: string | undefined;

  for (const step of c.steps) {
    clock += 45_000;
    const before = world.transcript(groupId, viewer).length;
    const mark = rec.calls.length;
    const line = `${NAMES[step.who]}: ${step.text}${step.photo ? " [photo]" : ""}`;
    world.say(users[step.who].id, groupId, step.text, { mentionNod: /@nod\b/i.test(step.text), ...(step.photo ? { mediaUrls: ["https://example.com/eval/receipt.jpg"] } : {}) });
    await world.settled();

    const sentLines = world.transcript(groupId, viewer).slice(before).filter((l) => l.from === "nod" && l.kind === "message");
    const calls = rec.calls.slice(mark);
    const tools: Array<{ name: string; input: unknown }> = [];
    for (const { response } of calls) {
      addUsage(usage, response.usage as Partial<Usage>);
      servedModel = response.model;
      lastStop = response.stop_reason;
      for (const b of response.content) if (b.type === "tool_use") tools.push({ name: b.name, input: b.input });
    }
    toolCalls += tools.length;
    const final = calls.at(-1)?.response;
    const replyText = final ? final.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("").trim() : "";
    const sent = sentLines.map((l) => ({ text: l.text, hasMedia: l.mediaUrls.length > 0 }));

    // Trace: the message, what Nod did, and what it sent.
    if (!trace.length && calls[0]) trace.push({ role: "system", content: typeof calls[0].request.system === "string" ? calls[0].request.system : JSON.stringify(calls[0].request.system) });
    trace.push({ role: "user", content: line });
    for (const { response } of calls) {
      for (const b of response.content) {
        if (b.type === "tool_use") trace.push({ role: "tool_call", name: b.name, content: JSON.stringify(b.input, null, 2) });
      }
    }
    for (const { request } of calls.slice(1)) {
      const last = request.messages?.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) for (const b of last.content) if (b.type === "tool_result") trace.push({ role: "tool_result", content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
    }
    trace.push({ role: "assistant", content: sent.length ? sent.map((m) => (m.hasMedia ? `[picture] ${m.text}` : m.text)).join("\n---\n") : "(silent)" });

    if (step.expect.good) {
      const result = checkStep(step, { sent, replyText, tools: tools.map((t) => t.name), called: calls.length > 0 });
      checks.push(...result);
      for (const r of result) if (!r.pass) explanations.push(`${r.id}: ${r.detail ?? "failed"}`);
      if (judge && step.expect.reply === "speak" && sent.length) {
        const j = await judge({ chat, message: line, actions: tools, sent: sent.map((m) => (m.hasMedia ? `[picture] ${m.text}` : m.text)), good: step.expect.good });
        judged.push(j.scores);
        addUsage(judgeUsage, j.usage as Partial<Usage>);
        if (j.explanation.trim()) explanations.push(`grader: ${j.explanation.trim()}`);
      }
    }
    chat.push(line, ...sentLines.map((l) => `Nod: ${l.mediaUrls.length ? "[picture] " : ""}${l.text}`));
  }

  const rules = checks.length ? checks.filter((x) => x.pass).length / checks.length : 1;
  const criteria = judged.flatMap((s) => Object.values(s));
  const judgeScore = criteria.length ? criteria.filter(Boolean).length / criteria.length : 1;
  const pass = checks.every((x) => x.pass) && criteria.every(Boolean);
  return {
    row: {
      prompt_id: c.id,
      rep,
      prompt: c.steps.map((s) => `${NAMES[s.who]}: ${s.text}`).join("\n"),
      tags: c.tags,
      status: "ok",
      stop_reason: lastStop,
      grade: { pass, rules, judge: judgeScore },
      explanation: { pass: explanations.join("\n") },
      model: servedModel,
      usage,
      ...(judge ? { judge_model: JUDGE_MODEL, judge_usage: judgeUsage } : {}),
      latency_s: Math.round((Date.now() - started) / 100) / 10,
      tool_calls: toolCalls,
      meta: { checks: checks.filter((x) => !x.pass), judged },
    },
    trace,
  };
}

function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

async function main() {
  const o = args();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error("Set ANTHROPIC_API_KEY first: these tests make real Claude calls.");
    process.exit(1);
  }
  const dir = path.join(FLOW_DIR, o.variant);
  mkdirSync(path.join(dir, "traces"), { recursive: true });
  const state = path.join(FLOW_DIR, "_state.json");
  if (!existsSync(state)) {
    writeFileSync(
      state,
      JSON.stringify(
        {
          flow: "reply-quality",
          metrics: [
            { id: "pass", label: "Pass", kind: "binary" },
            { id: "rules", label: "House rules", kind: "float", scale: 1 },
            { id: "judge", label: "Grader", kind: "float", scale: 1 },
          ],
          perf_fields: [{ id: "cost_usd", label: "Cost", unit: "$" }, { id: "latency_s", label: "Time", unit: "s" }, { id: "tool_calls", label: "Actions" }],
          variants: [{ id: "baseline" }],
        },
        null,
        2,
      ),
    );
  }
  const resultsPath = path.join(dir, "results.jsonl");
  const errorsPath = path.join(dir, "errors.jsonl");
  const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.prompt_id}#${r.rep}`; }) : []);
  const cases = CASES.filter((c) => !o.only || o.only.includes(c.id));
  const jobs = cases.flatMap((c) => Array.from({ length: o.reps }, (_, rep) => ({ c, rep }))).filter((j) => !done.has(`${j.c.id}#${j.rep}`));
  const judge = o.judge ? createJudge(new Anthropic({ maxRetries: 4 })) : undefined;
  console.log(`Running ${jobs.length} case runs (${cases.length} cases × ${o.reps} reps, ${done.size} already done) into ${path.relative(process.cwd(), dir)}`);

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { c, rep } = jobs[next++]!;
      let timer: NodeJS.Timeout | undefined;
      try {
        const { row, trace } = await Promise.race([
          runCase(c, rep, judge),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), o.timeoutS * 1000);
          }),
        ]);
        writeFileSync(path.join(dir, "traces", `${c.id}_rep${rep}.json`), JSON.stringify(trace, null, 2));
        appendFileSync(resultsPath, JSON.stringify(row) + "\n");
        console.log(`${row.grade.pass ? "PASS" : "FAIL"}  ${c.id}${o.reps > 1 ? ` #${rep}` : ""}  rules ${Math.round(row.grade.rules * 100)}%  grader ${Math.round(row.grade.judge * 100)}%${row.grade.pass ? "" : `\n      ${row.explanation.pass.split("\n").join("\n      ")}`}`);
      } catch (err) {
        const e = err as Error & { status?: number };
        const failure = e.message === "timeout" ? "timeout" : e.message?.startsWith("judge_") ? "grader_error" : e.status ? "api_error" : "harness_error";
        appendFileSync(errorsPath, JSON.stringify({ prompt_id: c.id, rep, failure, error: String(e.message).slice(0, 300), at: new Date().toISOString() }) + "\n");
        console.log(`ERROR ${c.id}: ${failure} ${String(e.message).slice(0, 120)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));

  const rows = existsSync(resultsPath) ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const passed = rows.filter((r) => r.grade.pass).length;
  const [lo, hi] = wilson(passed, rows.length);
  const mean = (k: "rules" | "judge") => (rows.length ? rows.reduce((s, r) => s + r.grade[k], 0) / rows.length : 0);
  console.log(`\n${passed}/${rows.length} cases passed (${Math.round((passed / Math.max(1, rows.length)) * 100)}%, 95% range ${Math.round(lo * 100)}–${Math.round(hi * 100)}%). House rules ${Math.round(mean("rules") * 100)}%, grader ${Math.round(mean("judge") * 100)}%.`);
  const byTag = new Map<string, [number, number]>();
  for (const r of rows) {
    const t = r.tags[0];
    const [p, n] = byTag.get(t) ?? [0, 0];
    byTag.set(t, [p + (r.grade.pass ? 1 : 0), n + 1]);
  }
  console.log([...byTag].map(([t, [p, n]]) => `${t} ${p}/${n}`).join("  ·  "));
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
