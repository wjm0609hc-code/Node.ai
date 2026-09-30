// Date polls (Phase 1 step 12): "@Nod when can everyone do Tulum?" Nod posts a
// short header and then one message per date; people tap 👍 (or ❤️) on every
// date that works for them, and removing the tapback takes it back. Replies
// like "1 3", "all" or "can't do 2" still count too, silently. The poll closes
// at its deadline, or 10 minutes after everyone in the group has answered (time
// to finish tapping), and Nod posts the dates that work for the most people.
// Polls are decisions of kind "date_poll", so a group has one open vote or poll
// at a time, and they reuse the vote nudge and deadline jobs.

import type { ContextSection } from "../agent/context";
import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool, type ToolContext } from "../agent/tools";
import type { ChatMember, DatePollChoice, Decision, Group, Store } from "../db/store";
import type { MessageCall } from "../inbound/pipeline";
import type { Scheduler, VotingJob } from "../jobs/scheduler";
import type { Logger } from "../lib/log";
import { formatLocal, localDateTimeToUtc, toLocalDateTime } from "../lib/time";
import type { InboundReaction, MessagingProvider, Tapback } from "../messaging/types";
import { parseTapbackText } from "../voting/votes";
import { applyAnswer, formatRange, parseAvailability, pickDates, type Answer } from "./availability";

export interface DatePollDeps {
  store: Store;
  provider: MessagingProvider;
  scheduler: Scheduler;
  logger: Logger;
  defaultTimezone: string;
  now?: () => Date;
}

const HOUR = 3_600_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CHOICES = 6;
const DEFAULT_HOURS = 48;
const MAX_DAYS = 14;
const NUDGE_BEFORE = 3 * HOUR;
const NUDGE_MIN = 4 * HOUR;
const KIND = "date_poll";
/** Once everyone has answered, the poll closes this much later (or at its deadline, if sooner). */
const SETTLE_MS = 10 * 60_000;
/** Tapbacks that mean "this date works". A dislike means it doesn't. */
const YES: ReadonlySet<Tapback> = new Set<Tapback>(["love", "like", "emphasize"]);

export function createDatePolls(deps: DatePollDeps) {
  const { store, provider, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const tzOf = (g: Group | undefined) => g?.timezone ?? deps.defaultTimezone;
  const andList = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
  const label = (c: DatePollChoice) => formatRange(c.startsOn, c.endsOn);
  const post = (group: Group, text: string) => provider.send({ groupId: group.providerGroupId }, { text });

  async function openPoll(groupId: string): Promise<Decision | undefined> {
    const d = await store.openDecision(groupId);
    return d?.kind === KIND ? d : undefined;
  }

  async function schedule(d: Decision): Promise<void> {
    if (!d.deadlineAt) return;
    const long = d.deadlineAt.getTime() - now().getTime() >= NUDGE_MIN;
    await deps.scheduler.scheduleVote({ decisionId: d.id, deadlineAt: d.deadlineAt, ...(long ? { nudgeAt: new Date(d.deadlineAt.getTime() - NUDGE_BEFORE) } : {}) });
  }

  // ---- answers ----

  /** Records an answer; once everyone in the group has answered, the poll closes shortly after. */
  async function answer(d: Decision, userId: string, a: Answer): Promise<number[]> {
    const choices = await store.datePollChoices(d.id);
    const current = (await store.datePollResponses(d.id)).find((r) => r.userId === userId)?.positions;
    const positions = applyAnswer(current, a, choices.length);
    await store.setDatePollResponse(d.id, userId, positions);
    logger.info("dates.answer", { decisionId: d.id });
    await closeSoonIfEveryoneAnswered(d);
    return positions;
  }

  async function everyoneAnswered(d: Decision): Promise<boolean> {
    const members = await store.groupMembers(d.groupId);
    const answered = new Set((await store.datePollResponses(d.id)).map((r) => r.userId));
    return members.length > 0 && members.every((m) => answered.has(m.userId));
  }

  /** Brings the deadline forward to 10 minutes from now, so people can finish tapping before the result. */
  async function closeSoonIfEveryoneAnswered(d: Decision): Promise<void> {
    if (!(await everyoneAnswered(d))) return;
    const soon = new Date(now().getTime() + SETTLE_MS);
    const fresh = await store.getDecision(d.id);
    if (!fresh || fresh.status !== "open" || (fresh.deadlineAt && fresh.deadlineAt <= soon)) return;
    await store.updateDecision(d.id, { deadlineAt: soon });
    await deps.scheduler.scheduleVote({ decisionId: d.id, deadlineAt: soon });
    logger.info("dates.closing_soon", { decisionId: d.id });
  }

  /** A tapback on one of the poll's date messages: 👍/❤️ adds that date, removing it (or 👎) takes it away. */
  async function tapback(groupId: string, userId: string, messageId: string, reaction: Tapback, removed: boolean): Promise<void> {
    const choice = await store.datePollChoiceByMessage(messageId);
    if (!choice) return;
    const d = await store.getDecision(choice.decisionId);
    if (!d || d.kind !== KIND || d.status !== "open" || d.groupId !== groupId) return;
    if (!(await store.groupMembers(groupId)).some((m) => m.userId === userId)) return;
    const adds = YES.has(reaction) && !removed;
    if (!adds && !YES.has(reaction) && reaction !== "dislike") return; // laugh, question: not an answer
    const current = (await store.datePollResponses(d.id)).find((r) => r.userId === userId)?.positions ?? [];
    const next = new Set(current);
    if (adds) next.add(choice.position);
    else next.delete(choice.position);
    await store.setDatePollResponse(d.id, userId, [...next].sort((a, b) => a - b));
    logger.info("dates.answer", { decisionId: d.id, via: "tapback" });
    await closeSoonIfEveryoneAnswered(d);
  }

  async function onReaction(call: { event: InboundReaction; groupId: string; userId: string }): Promise<void> {
    await tapback(call.groupId, call.userId, call.event.targetMessageId, call.event.reaction, call.event.removed);
  }

  /** Counts SMS tapback text on a date, and replies like "1 3", "all" or "can't do 2", in the group. Nod says nothing. */
  async function captureAnswer(call: MessageCall): Promise<void> {
    if (!call.groupId || call.optedOut) return;
    const tb = parseTapbackText(call.event.text);
    if (tb) {
      const messageId = await store.findMessageIdByText(call.groupId, tb.quoted);
      if (messageId) await tapback(call.groupId, call.senderUserId, messageId, tb.reaction, tb.removed);
      return;
    }
    const d = await openPoll(call.groupId);
    if (!d) return;
    const choices = await store.datePollChoices(d.id);
    const parsed = parseAvailability(call.event.text, choices.length);
    if (parsed) await answer(d, call.senderUserId, parsed);
  }

  // ---- closing ----

  async function close(d: Decision): Promise<void> {
    const allIn = await everyoneAnswered(d);
    const [choices, responses, members, group] = await Promise.all([
      store.datePollChoices(d.id),
      store.datePollResponses(d.id),
      store.groupMembers(d.groupId),
      store.getGroup(d.groupId),
    ]);
    const best = pickDates(choices, responses.map((r) => r.positions));
    if (!best) {
      if (!(await store.transitionDecision(d.id, ["open"], { status: "cancelled" }))) return;
      await post(
        group!,
        responses.length ? `None of those dates work for anyone who answered “${d.question}”. Try another set any time.` : `The date poll “${d.question}” closed with no answers.`,
      );
      logger.info("dates.closed", { decisionId: d.id, outcome: "none" });
      return;
    }
    if (!(await store.transitionDecision(d.id, ["open"], { status: "decided" }))) return;
    await store.markDatePollChoice(d.id, best.position);
    const chosen = choices.find((c) => c.position === best.position)!;
    const name = (id: string) => {
      const m = members.find((x) => x.userId === id);
      return m ? displayName(m) : "someone";
    };
    const cant = responses.filter((r) => !r.positions.includes(best.position)).map((r) => name(r.userId));
    const answered = new Set(responses.map((r) => r.userId));
    const silent = members.filter((m) => !answered.has(m.userId)).map(displayName);
    const who = best.count === members.length ? "everyone" : `${best.count} of ${members.length}`;
    await post(
      group!,
      `${allIn ? "Everyone's answered. " : ""}Dates: ${label(chosen)} works for ${who}.` +
        (cant.length ? ` ${andList(cant)} can't make it.` : "") +
        (silent.length ? ` No answer from ${andList(silent)}.` : ""),
    );
    logger.info("dates.closed", { decisionId: d.id, outcome: "decided" });
  }

  async function nudge(d: Decision): Promise<void> {
    if (d.nudgeSentAt || !d.deadlineAt) return;
    await store.updateDecision(d.id, { nudgeSentAt: now() });
    const [choices, responses, members, group] = await Promise.all([
      store.datePollChoices(d.id),
      store.datePollResponses(d.id),
      store.groupMembers(d.groupId),
      store.getGroup(d.groupId),
    ]);
    const answered = new Set(responses.map((r) => r.userId));
    const text =
      `${group?.name ?? "Your group"} is picking dates: “${d.question}” ${choices.map((c) => label(c)).join(", ")}. ` +
      `Tap 👍 on the dates that work in the group, or reply here with them. Closes ${formatLocal(d.deadlineAt, tzOf(group))}.`;
    for (const m of members) if (!answered.has(m.userId)) await provider.send({ phone: m.phone }, { text });
    logger.info("dates.nudged", { decisionId: d.id });
  }

  /** Runs a scheduled nudge or deadline for a date poll. Safe to repeat. */
  async function runJob(job: VotingJob): Promise<void> {
    const d = await store.getDecision(job.decisionId);
    if (!d || d.kind !== KIND || d.status !== "open") return;
    if (job.type === "nudge") return nudge(d);
    if (d.deadlineAt?.toISOString() === job.deadlineAt) return close(d);
  }

  // ---- tools ----

  async function pollFor(ctx: ToolContext, decisionId?: string): Promise<Decision> {
    let d: Decision | undefined;
    if (ctx.chat.kind === "group") d = decisionId ? await store.getDecision(decisionId) : await openPoll(ctx.chat.groupId);
    else if (decisionId) {
      d = await store.getDecision(decisionId);
      if (d && !(await store.groupMembers(d.groupId)).some((m) => m.userId === ctx.caller.userId)) d = undefined;
    }
    const inChat = ctx.chat.kind !== "group" || d?.groupId === ctx.chat.groupId;
    if (!d || d.kind !== KIND || d.status !== "open" || !inChat) {
      throw new ToolError(ctx.chat.kind === "group" ? "There's no open date poll in this group." : "Which date poll? Use a decision_id from open_date_polls.");
    }
    return d;
  }

  const runDatePoll = defineTool<{ question?: string; choices: Array<{ starts_on: string; ends_on?: string }>; deadline_local?: string; hours?: number }>({
    name: "run_date_poll",
    description:
      "Ask the group which dates work, when they're choosing when to do something (a trip, a dinner). 2 to 6 choices, each a date " +
      "(starts_on, like 2027-03-14) or a range (plus ends_on). Nod posts the poll itself, one message per date; people tap 👍 on every " +
      "date that works. Deadline: deadline_local (this chat's timezone) or hours; default 48 hours. If they haven't said which dates to " +
      "offer, ask first. After it succeeds, end your turn without writing anything.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Short, e.g. 'When works for Tulum?'" },
        choices: {
          type: "array",
          items: { type: "object", properties: { starts_on: { type: "string" }, ends_on: { type: "string" } }, required: ["starts_on"], additionalProperties: false },
        },
        deadline_local: { type: "string" },
        hours: { type: "number" },
      },
      required: ["choices"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (ctx.chat.kind !== "group") throw new ToolError("Date polls are run from the group chat.");
      const group = (await store.getGroup(ctx.chat.groupId))!;
      const tz = tzOf(group);
      if (input.choices.length < 2 || input.choices.length > MAX_CHOICES) throw new ToolError(`A date poll needs 2 to ${MAX_CHOICES} choices.`);
      const today = toLocalDateTime(now(), tz).slice(0, 10);
      const choices = input.choices.map((c) => {
        const endsOn = c.ends_on && c.ends_on !== c.starts_on ? c.ends_on : null;
        if (!DATE.test(c.starts_on) || (endsOn && !DATE.test(endsOn)) || Number.isNaN(Date.parse(c.starts_on))) {
          throw new ToolError("Give dates like 2027-03-14.");
        }
        if (endsOn && endsOn < c.starts_on) throw new ToolError("A range has to end after it starts.");
        if (c.starts_on < today) throw new ToolError(`${formatRange(c.starts_on, endsOn)} has already passed.`);
        return { startsOn: c.starts_on, endsOn };
      });
      const keys = new Set(choices.map((c) => `${c.startsOn}/${c.endsOn}`));
      if (keys.size !== choices.length) throw new ToolError("Two of those choices are the same dates.");

      const open = await store.openDecision(group.id);
      if (open) throw new ToolError(`A ${open.kind === KIND ? "date poll" : "vote"} is already open: “${open.question}”. Close or cancel it first.`);

      let deadlineAt: Date;
      if (input.deadline_local) {
        const d = localDateTimeToUtc(input.deadline_local, tz);
        if (!d) throw new ToolError("Give the deadline as a local date and time like 2026-10-02T18:00.");
        deadlineAt = d;
      } else {
        deadlineAt = new Date(now().getTime() + (input.hours ?? DEFAULT_HOURS) * HOUR);
      }
      if (deadlineAt.getTime() < now().getTime() + 10 * 60_000) throw new ToolError("Pick a deadline at least 10 minutes from now.");
      if (deadlineAt.getTime() > now().getTime() + MAX_DAYS * 24 * HOUR) throw new ToolError(`Date polls can run for at most ${MAX_DAYS} days.`);

      const question = input.question?.trim() || "Which dates work?";
      const d = await store.createDecision({
        groupId: group.id,
        kind: KIND,
        question,
        createdByUserId: ctx.caller.userId,
        deadlineAt,
        round: 1,
        parentDecisionId: null,
        optionIds: [],
      });
      await store.addDatePollChoices(d.id, choices);
      await schedule(d);
      // A header, then one message per date so people can tap 👍 on each (a deliberate exception to one message per action).
      await post(group, `Date poll: ${question} Tap 👍 on every date that works for you. Closes ${formatLocal(deadlineAt, tz)}.`);
      for (const [i, c] of choices.entries()) {
        const sent = await post(group, formatRange(c.startsOn, c.endsOn));
        await store.setDatePollChoiceMessage(d.id, i + 1, sent.messageId);
      }
      logger.info("dates.started", { decisionId: d.id, choices: choices.length });
      return "The date poll is posted. End your turn without writing anything.";
    },
  });

  const answerDatePoll = defineTool<{ decision_id?: string; mode: Answer["mode"]; positions?: number[] }>({
    name: "answer_date_poll",
    description:
      "Record which dates work for the caller, when they tell you directly or reply privately to a date poll reminder. mode: set (exactly " +
      "these numbers), add, remove, all, or none. In a private chat, pass the decision_id from open_date_polls. Only for the caller's own answer.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: { type: "string" },
        mode: { type: "string", enum: ["set", "add", "remove", "all", "none"] },
        positions: { type: "array", items: { type: "integer" } },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const d = await pollFor(ctx, input.decision_id);
      const n = (await store.datePollChoices(d.id)).length;
      let a: Answer;
      if (input.mode === "all" || input.mode === "none") a = { mode: input.mode };
      else {
        const positions = [...new Set(input.positions ?? [])];
        if (!positions.length || positions.some((p) => !Number.isInteger(p) || p < 1 || p > n)) throw new ToolError(`Use numbers from 1 to ${n}.`);
        a = { mode: input.mode, positions };
      }
      const positions = await answer(d, ctx.caller.userId, a);
      return `Recorded ${ctx.caller.name}: ${positions.length ? positions.join(", ") : "none"} work.`;
    },
  });

  const closeDatePoll = defineTool<{ decision_id?: string }>({
    name: "close_date_poll",
    description: "Close the group's open date poll now and post the dates that work best (anyone in the group can). After it succeeds, end your turn without writing anything.",
    inputSchema: { type: "object", properties: { decision_id: { type: "string" } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      await close(await pollFor(ctx, input.decision_id));
      return "The result is posted. End your turn without writing anything.";
    },
  });

  const cancelDatePoll = defineTool<{ decision_id?: string }>({
    name: "cancel_date_poll",
    description: "Cancel the group's open date poll without a result. Then say so in a few words.",
    inputSchema: { type: "object", properties: { decision_id: { type: "string" } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      const d = await pollFor(ctx, input.decision_id);
      await store.transitionDecision(d.id, ["open"], { status: "cancelled" });
      return `Cancelled “${d.question}”.`;
    },
  });

  // ---- context ----

  async function describeOpen(d: Decision, members: ChatMember[], viewerId?: string): Promise<string> {
    const [choices, responses, group] = await Promise.all([store.datePollChoices(d.id), store.datePollResponses(d.id), store.getGroup(d.groupId)]);
    const lines = choices.map((c) => `${c.position}. ${label(c)} (${responses.filter((r) => r.positions.includes(c.position)).length} can)`);
    if (viewerId) {
      const mine = responses.find((r) => r.userId === viewerId);
      lines.push(mine ? `They said ${mine.positions.length ? mine.positions.join(", ") : "none"} work.` : "They haven't answered.");
    } else {
      const answered = new Set(responses.map((r) => r.userId));
      const missing = members.filter((m) => !answered.has(m.userId)).map(displayName);
      if (missing.length) lines.push(`No answer yet: ${missing.join(", ")}.`);
    }
    return [`[date poll ${d.id}] in “${group?.name ?? "a group"}”: “${d.question}”, closes ${d.deadlineAt ? formatLocal(d.deadlineAt, tzOf(group)) : "?"}`, ...lines].join("\n");
  }

  const section: ContextSection = async (call) => {
    if (call.groupId) {
      const d = await openPoll(call.groupId);
      if (d) return { title: "open_date_poll", body: await describeOpen(d, await store.groupMembers(call.groupId)) };
      const last = (await store.listDecisions(call.groupId)).find((x) => x.kind === KIND && x.status === "decided");
      const chosen = last && (await store.datePollChoices(last.id)).find((c) => c.chosen);
      if (!chosen) return null;
      return {
        title: "chosen_dates",
        body: `From the date poll “${last!.question}”: ${label(chosen)} (starts_on ${chosen.startsOn}${chosen.endsOn ? `, ends_on ${chosen.endsOn}` : ""}). Use these dates for searches and bookings unless told otherwise.`,
      };
    }
    const open = (await store.openDecisionsForUser(call.senderUserId)).filter((d) => d.kind === KIND).slice(0, 3);
    if (!open.length) return null;
    const blocks = await Promise.all(open.map(async (d) => describeOpen(d, await store.groupMembers(d.groupId), call.senderUserId)));
    return { title: "open_date_polls", body: blocks.join("\n\n") };
  };

  const tools: NodTool<any>[] = [runDatePoll, answerDatePoll, closeDatePoll, cancelDatePoll];
  return { tools, section, captureAnswer, onReaction, runJob };
}

export type DatePolls = ReturnType<typeof createDatePolls>;
