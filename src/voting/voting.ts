// Voting (Phase 1 step 7): numbered votes on options (rental links and search
// picks), counted silently from replies and tapbacks, closed at a deadline with
// one runoff on a tie. Only the vote messages themselves are posted by Nod.

import type { ContextSection } from "../agent/context";
import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool, type ToolContext } from "../agent/tools";
import type { Decision, Group, Option, Store } from "../db/store";
import type { MessageCall } from "../inbound/pipeline";
import type { Scheduler, VotingJob } from "../jobs/scheduler";
import type { Logger } from "../lib/log";
import { formatLocal, localDateTimeToUtc } from "../lib/time";
import type { InboundReaction, MessagingProvider, Tapback } from "../messaging/types";
import { optionLabel, optionLine } from "../options/cards";
import { parseTapbackText, parseVoteText, tally, VOTING_TAPBACKS } from "./votes";

export interface VotingDeps {
  store: Store;
  provider: MessagingProvider;
  scheduler: Scheduler;
  logger: Logger;
  defaultTimezone: string;
  now?: () => Date;
}

const HOUR = 3_600_000;
const MAX_OPTIONS = 6;
const DEFAULT_HOURS = 24;
const MAX_DAYS = 14;
/** Non-voters get a private nudge this long before the close, if the vote runs at least NUDGE_MIN. */
const NUDGE_BEFORE = 3 * HOUR;
const NUDGE_MIN = 4 * HOUR;

export function createVoting(deps: VotingDeps) {
  const { store, provider, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const tzOf = (g: Group | undefined) => g?.timezone ?? deps.defaultTimezone;

  async function optionsOf(d: Decision): Promise<Array<{ position: number; option: Option }>> {
    const rows = await store.decisionOptions(d.id);
    const out = [];
    for (const r of rows) {
      const option = await store.getOption(r.optionId);
      if (option) out.push({ position: r.position, option });
    }
    return out;
  }

  async function post(group: Group, text: string): Promise<void> {
    await provider.send({ groupId: group.providerGroupId }, { text });
  }

  async function schedule(d: Decision): Promise<void> {
    if (!d.deadlineAt) return;
    const long = d.deadlineAt.getTime() - now().getTime() >= NUDGE_MIN;
    await deps.scheduler.scheduleVote({
      decisionId: d.id,
      deadlineAt: d.deadlineAt,
      ...(long ? { nudgeAt: new Date(d.deadlineAt.getTime() - NUDGE_BEFORE) } : {}),
    });
  }

  function numbersPhrase(n: number): string {
    const nums = Array.from({ length: n }, (_, i) => String(i + 1));
    return nums.length <= 2 ? nums.join(" or ") : `${nums.slice(0, -1).join(", ")} or ${nums.at(-1)}`;
  }

  function andList(items: string[]): string {
    return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  }

  // ---- casting ----

  async function record(d: Decision, userId: string, optionId: string): Promise<void> {
    if (d.tieBreakUserId) {
      if (userId === d.tieBreakUserId) await resolveTieBreak(d, optionId, userId);
      return;
    }
    await store.setVote(d.id, userId, optionId);
    logger.info("voting.vote", { decisionId: d.id });
  }

  async function applyTapback(d: Decision, userId: string, optionId: string, reaction: Tapback, removed: boolean) {
    if (!VOTING_TAPBACKS.has(reaction) || d.tieBreakUserId) return;
    if (removed) await store.removeVote(d.id, userId, optionId);
    else await store.setVote(d.id, userId, optionId);
  }

  function matchByName(opts: Array<{ option: Option }>, name: string): Option | undefined {
    const norm = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^\p{L}\p{N} ]/gu, "").trim();
    const q = norm(name);
    if (q.length < 3) return undefined;
    const hits = opts.filter(({ option }) => {
      const label = norm(optionLabel(option));
      return label.includes(q) || (label.length >= 3 && q.includes(label));
    });
    return hits.length === 1 ? hits[0]!.option : undefined;
  }

  /** Counts votes from ordinary group messages ("2", "I vote Casa Azul", SMS tapback text). Nod says nothing. */
  async function captureVote(call: MessageCall): Promise<void> {
    if (!call.groupId || call.optedOut) return;
    const d = await store.openDecision(call.groupId);
    if (!d) return;
    const opts = await optionsOf(d);
    const text = call.event.text;

    const tapback = parseTapbackText(text);
    if (tapback) {
      const messageId = await store.findMessageIdByText(call.groupId, tapback.quoted);
      const option = messageId ? await store.optionByMessage(call.groupId, messageId) : undefined;
      if (option && opts.some((o) => o.option.id === option.id)) {
        await applyTapback(d, call.senderUserId, option.id, tapback.reaction, tapback.removed);
      }
      return;
    }

    const parsed = parseVoteText(text, opts.length);
    if (!parsed) return;
    const option = "number" in parsed ? opts.find((o) => o.position === parsed.number)?.option : matchByName(opts, parsed.name);
    if (option) await record(d, call.senderUserId, option.id);
  }

  /** A tapback on an option's original link message is a vote for it. */
  async function onReaction(call: { event: InboundReaction; groupId: string; userId: string }): Promise<void> {
    const d = await store.openDecision(call.groupId);
    if (!d) return;
    const option = await store.optionByMessage(call.groupId, call.event.targetMessageId);
    if (!option) return;
    if (!(await store.decisionOptions(d.id)).some((o) => o.optionId === option.id)) return;
    await applyTapback(d, call.userId, option.id, call.event.reaction, call.event.removed);
  }

  // ---- closing ----

  async function close(d: Decision): Promise<void> {
    const group = (await store.getGroup(d.groupId))!;
    const opts = await optionsOf(d);
    const byId = new Map(opts.map((o) => [o.option.id, o.option]));
    const { counts, total, outcome } = tally(
      opts.map((o) => o.option.id),
      await store.votesFor(d.id),
    );

    if (outcome.kind === "none") {
      await store.updateDecision(d.id, { status: "cancelled" });
      await post(group, `The vote on “${d.question}” closed with no votes.`);
    } else if (outcome.kind === "winner") {
      await store.updateDecision(d.id, { status: "decided", winningOptionId: outcome.optionId });
      const others = opts
        .filter((o) => o.option.id !== outcome.optionId && counts[o.option.id]! > 0)
        .map((o) => `${optionLabel(o.option)}: ${counts[o.option.id]}`);
      const n = counts[outcome.optionId]!;
      await post(
        group,
        `Vote closed: ${optionLabel(byId.get(outcome.optionId)!)} wins with ${n} of ${total} vote${total === 1 ? "" : "s"}${others.length ? ` (${others.join(", ")})` : ""}.`,
      );
    } else if (d.round === 1) {
      await store.updateDecision(d.id, { status: "runoff" });
      const originalMs = (d.deadlineAt ?? now()).getTime() - d.createdAt.getTime();
      const runoffMs = Math.min(12 * HOUR, Math.max(HOUR, originalMs / 2));
      const runoff = await store.createDecision({
        groupId: d.groupId,
        kind: d.kind,
        question: d.question,
        createdByUserId: d.createdByUserId,
        deadlineAt: new Date(now().getTime() + runoffMs),
        round: 2,
        parentDecisionId: d.id,
        optionIds: outcome.optionIds,
      });
      await schedule(runoff);
      const labels = outcome.optionIds.map((id) => optionLabel(byId.get(id)!));
      const each = counts[outcome.optionIds[0]!]!;
      await post(
        group,
        `It's a tie between ${andList(labels)} (${each} each). Runoff: reply ${numbersPhrase(labels.length)} by ${formatLocal(runoff.deadlineAt!, tzOf(group))}.\n` +
          outcome.optionIds.map((id, i) => `${i + 1}. ${optionLine(byId.get(id)!)}`).join("\n"),
      );
    } else if (d.createdByUserId) {
      await store.updateDecision(d.id, { deadlineAt: null, tieBreakUserId: d.createdByUserId });
      const starter = await store.getUser(d.createdByUserId);
      await post(
        group,
        `Still tied. ${starter ? displayName(starter) : "Whoever started this vote"}, you started this vote, so you break the tie: reply ${numbersPhrase(opts.length)}.`,
      );
    } else {
      await store.updateDecision(d.id, { status: "cancelled" });
      await post(group, "Still tied, so there's no winner. Start a new vote any time.");
    }
    logger.info("voting.closed", { decisionId: d.id, outcome: outcome.kind, round: d.round });
  }

  async function resolveTieBreak(d: Decision, optionId: string, userId: string): Promise<void> {
    await store.updateDecision(d.id, { status: "decided", winningOptionId: optionId, tieBreakUserId: null });
    const group = (await store.getGroup(d.groupId))!;
    const who = await store.getUser(userId);
    const option = await store.getOption(optionId);
    await post(group, `${who ? displayName(who) : "The tie-breaker"} broke the tie: ${optionLabel(option!)} wins.`);
  }

  async function nudge(d: Decision): Promise<void> {
    if (d.nudgeSentAt || !d.deadlineAt) return;
    await store.updateDecision(d.id, { nudgeSentAt: now() });
    const group = (await store.getGroup(d.groupId))!;
    const voted = new Set((await store.votesFor(d.id)).map((v) => v.userId));
    const opts = await optionsOf(d);
    const text =
      `The ${group.name ?? "group"} vote closes ${formatLocal(d.deadlineAt, tzOf(group))}: “${d.question}” ` +
      `${opts.map((o) => `${o.position}. ${optionLabel(o.option)}`).join(" ")}. Reply here with a number to vote.`;
    for (const m of await store.groupMembers(d.groupId)) {
      if (!voted.has(m.userId)) await provider.send({ phone: m.phone }, { text });
    }
    logger.info("voting.nudged", { decisionId: d.id });
  }

  /** Runs a scheduled job. Safe to repeat: it re-checks the vote first. */
  async function runJob(job: VotingJob): Promise<void> {
    const d = await store.getDecision(job.decisionId);
    if (!d || d.status !== "open") return;
    if (job.type === "nudge") return nudge(d);
    if (d.deadlineAt?.toISOString() === job.deadlineAt) return close(d);
  }

  // ---- tools ----

  async function groupDecision(ctx: ToolContext, decisionId?: string): Promise<Decision> {
    if (ctx.chat.kind !== "group") throw new ToolError("Votes are run from the group chat.");
    const d = decisionId ? await store.getDecision(decisionId) : await store.openDecision(ctx.chat.groupId);
    if (!d || d.groupId !== ctx.chat.groupId || d.status !== "open") throw new ToolError("There's no open vote in this group.");
    return d;
  }

  const startVote = defineTool<{ option_ids: string[]; question?: string; deadline_local?: string; hours?: number }>({
    name: "start_vote",
    description:
      "Start a vote in this group on 2 to 6 options (rental links or search picks; use the ids from rental_options or search_options). " +
      "Nod posts the numbered vote message itself; people reply with a number or tap a heart on a link. " +
      "Deadline: deadline_local as a local date-time like 2026-10-02T18:00 (in this chat's timezone), or hours from now; default 24 hours. " +
      "After it succeeds, end your turn without writing anything.",
    inputSchema: {
      type: "object",
      properties: {
        option_ids: { type: "array", items: { type: "string" } },
        question: { type: "string", description: "Short, e.g. 'Where to stay?' or 'Dinner Saturday?'" },
        deadline_local: { type: "string", description: "Local date-time, e.g. 2026-10-02T18:00." },
        hours: { type: "number", description: "Hours from now, instead of deadline_local." },
      },
      required: ["option_ids"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (ctx.chat.kind !== "group") throw new ToolError("Votes are run from the group chat.");
      const ids = [...new Set(input.option_ids)];
      if (ids.length < 2 || ids.length > MAX_OPTIONS) throw new ToolError(`A vote needs 2 to ${MAX_OPTIONS} options.`);
      const opts: Option[] = [];
      for (const id of ids) {
        const o = await store.getOption(id);
        if (!o || o.groupId !== ctx.chat.groupId) throw new ToolError("Those options aren't all in this group. Use ids from the options lists.");
        opts.push(o);
      }
      const open = await store.openDecision(ctx.chat.groupId);
      if (open) throw new ToolError(`A vote is already open: “${open.question}”. Close or cancel it first.`);

      const group = (await store.getGroup(ctx.chat.groupId))!;
      let deadline: Date;
      if (input.deadline_local) {
        const d = localDateTimeToUtc(input.deadline_local, tzOf(group));
        if (!d) throw new ToolError("Give the deadline as a local date and time like 2026-10-02T18:00.");
        deadline = d;
      } else {
        deadline = new Date(now().getTime() + (input.hours ?? DEFAULT_HOURS) * HOUR);
      }
      if (deadline.getTime() < now().getTime() + 10 * 60_000) {
        throw new ToolError("That deadline is in the past or too soon. Pick a time at least 10 minutes from now.");
      }
      if (deadline.getTime() > now().getTime() + MAX_DAYS * 24 * HOUR) throw new ToolError(`Votes can run for at most ${MAX_DAYS} days.`);

      const question = input.question?.trim() || "Which one?";
      const d = await store.createDecision({
        groupId: group.id,
        kind: "vote",
        question,
        createdByUserId: ctx.caller.userId,
        deadlineAt: deadline,
        round: 1,
        parentDecisionId: null,
        optionIds: opts.map((o) => o.id),
      });
      await schedule(d);
      const hint = opts.some((o) => o.providerMessageId) ? "Reply with a number, or tap ❤️ on the link." : "Reply with a number.";
      await post(
        group,
        `Vote: ${question}\n${opts.map((o, i) => `${i + 1}. ${optionLine(o)}`).join("\n")}\n${hint} Closes ${formatLocal(deadline, tzOf(group))}.`,
      );
      logger.info("voting.started", { decisionId: d.id, options: opts.length });
      return `The vote message is posted and closes ${formatLocal(deadline, tzOf(group))}. End your turn without writing anything.`;
    },
  });

  const castVote = defineTool<{ decision_id?: string; choice?: number; option_id?: string }>({
    name: "cast_vote",
    description:
      "Record the caller's own vote, when they ask you directly ('@Nod put me down for 2') or reply privately to a vote nudge. " +
      "choice is the option's number in the vote. In a private chat, pass the decision_id from open_votes. You can't vote for other people.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: { type: "string" },
        choice: { type: "integer", minimum: 1 },
        option_id: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
    async run(input, ctx) {
      let d: Decision | undefined;
      if (ctx.chat.kind === "group") d = await groupDecision(ctx, input.decision_id);
      else {
        if (!input.decision_id) throw new ToolError("Which vote? Use a decision_id from open_votes.");
        d = await store.getDecision(input.decision_id);
        const member = d && (await store.groupMembers(d.groupId)).some((m) => m.userId === ctx.caller.userId);
        if (!d || !member || d.status !== "open") throw new ToolError("That vote isn't open to them.");
      }
      const opts = await optionsOf(d);
      const picked = input.option_id
        ? opts.find((o) => o.option.id === input.option_id)
        : opts.find((o) => o.position === input.choice);
      if (!picked) throw new ToolError(`Pick a number from 1 to ${opts.length}.`);
      if (d.tieBreakUserId && d.tieBreakUserId !== ctx.caller.userId) throw new ToolError("This vote is waiting for its tie-breaker.");
      await record(d, ctx.caller.userId, picked.option.id);
      return `Recorded ${ctx.caller.name}'s vote for ${optionLabel(picked.option)}.`;
    },
  });

  const closeVote = defineTool<{ decision_id?: string }>({
    name: "close_vote",
    description: "Close this group's open vote now and post the result (anyone in the group can). After it succeeds, end your turn without writing anything.",
    inputSchema: { type: "object", properties: { decision_id: { type: "string" } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      await close(await groupDecision(ctx, input.decision_id));
      return "The result is posted. End your turn without writing anything.";
    },
  });

  const cancelVote = defineTool<{ decision_id?: string }>({
    name: "cancel_vote",
    description: "Cancel this group's open vote without a result. Then tell the group in a few words.",
    inputSchema: { type: "object", properties: { decision_id: { type: "string" } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      const d = await groupDecision(ctx, input.decision_id);
      await store.updateDecision(d.id, { status: "cancelled" });
      logger.info("voting.cancelled", { decisionId: d.id });
      return `Cancelled “${d.question}”.`;
    },
  });

  // ---- context ----

  async function describeOpen(d: Decision, viewerUserId?: string): Promise<string[]> {
    const group = (await store.getGroup(d.groupId))!;
    const opts = await optionsOf(d);
    const votes = await store.votesFor(d.id);
    const { counts } = tally(
      opts.map((o) => o.option.id),
      votes,
    );
    const when = d.tieBreakUserId ? "waiting for its starter to break a tie" : d.deadlineAt ? `closes ${formatLocal(d.deadlineAt, tzOf(group))}` : "no deadline";
    const lines = opts.map((o) => {
      const n = counts[o.option.id] ?? 0;
      return `${o.position}. ${optionLine(o.option)} (${n} vote${n === 1 ? "" : "s"})`;
    });
    if (viewerUserId) {
      const mine = votes.find((v) => v.userId === viewerUserId);
      lines.push(mine ? `They voted for ${optionLabel(opts.find((o) => o.option.id === mine.optionId)!.option)}.` : "They haven't voted.");
    } else {
      const voted = new Set(votes.map((v) => v.userId));
      const missing = (await store.groupMembers(d.groupId)).filter((m) => !voted.has(m.userId)).map(displayName);
      if (missing.length) lines.push(`Not voted yet: ${missing.join(", ")}.`);
    }
    return [when, ...lines];
  }

  const section: ContextSection = async (call) => {
    if (call.groupId) {
      const d = await store.openDecision(call.groupId);
      if (d) {
        const [when, ...lines] = await describeOpen(d);
        return { title: "open_vote", body: [`[vote ${d.id}] “${d.question}”, ${when}`, ...lines].join("\n") };
      }
      const last = (await store.listDecisions(call.groupId)).find((x) => x.status === "decided" && x.winningOptionId);
      if (!last) return null;
      const winner = await store.getOption(last.winningOptionId!);
      return winner ? { title: "last_decision", body: `“${last.question}” → ${optionLine(winner)} [option ${winner.id}]` } : null;
    }
    const open = await store.openDecisionsForUser(call.senderUserId);
    if (!open.length) return null;
    const blocks = [];
    for (const d of open.slice(0, 3)) {
      const group = await store.getGroup(d.groupId);
      const [when, ...lines] = await describeOpen(d, call.senderUserId);
      blocks.push([`[vote ${d.id}] in “${group?.name ?? "a group"}”: “${d.question}”, ${when}`, ...lines].join("\n"));
    }
    return { title: "open_votes", body: blocks.join("\n\n") };
  };

  const tools: NodTool<any>[] = [startVote, castVote, closeVote, cancelVote];
  return { captureVote, onReaction, runJob, tools, section };
}

export type Voting = ReturnType<typeof createVoting>;
