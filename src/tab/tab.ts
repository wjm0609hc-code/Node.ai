// The running tab (Phase 1 step 11): who paid for what, who owes whom, and
// settling up. Expenses come from people telling Nod ("I paid $180 for
// groceries"), receipt photos, and booking deposits; settling up uses the
// step 10 payment flow when payments are set up, or tells people who to pay.
//
// Rule 3: nobody's balance or share is posted in the group. The group hears that
// an expense was added and the outcome of settling up; each person's numbers go
// to them privately.

import type { ContextSection } from "../agent/context";
import { displayName } from "../agent/context";
import { defineTool, ToolError, type NodTool, type ToolContext } from "../agent/tools";
import { resolveMember } from "../agent/tools/members";
import { money } from "../booking/shared";
import type { ChatMember, Group, LedgerEntryWithShares, PaymentCollection, PaymentRequest, Store } from "../db/store";
import type { Logger } from "../lib/log";
import type { MessagingProvider } from "../messaging/types";
import type { Payments } from "../payments/payments";
import { balances, equalSplit, exactSplit, receiptSplit, settleTransfers, TabMathError, type Share, type Transfer } from "./math";
import type { ReceiptReader } from "./receipts";

export interface TabDeps {
  store: Store;
  provider: MessagingProvider;
  logger: Logger;
  receiptReader: ReceiptReader;
  /** Step 10 payments, when set up; settling up then sends pay links. Read lazily (payments and the tab refer to each other). */
  payments: () => Payments | null;
  now?: () => Date;
}

const HOUR = 3_600_000;
const MAX_ENTRY_CENTS = 5_000_000;
const SETTLE_HOURS = 48;
/** A photo posted this recently counts as "this receipt". */
const RECENT_PHOTO_MINUTES = 30;

export function createTab(deps: TabDeps) {
  const { store, provider, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const nameIn = (members: ChatMember[], id: string) => {
    const m = members.find((x) => x.userId === id);
    return m ? displayName(m) : "someone";
  };

  function wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof TabMathError) throw new ToolError(err.message);
      throw err;
    }
  }

  async function groupOf(ctx: ToolContext): Promise<Group> {
    if (ctx.chat.kind !== "group") throw new ToolError("The tab lives in the group chat. Ask there.");
    return (await store.getGroup(ctx.chat.groupId))!;
  }

  const people = (ctx: ToolContext, names: string[] | undefined) => (names?.length ? names.map((n) => resolveMember(ctx, n).userId) : ctx.members.map((m) => m.userId));

  // ---- tools ----

  const recordExpense = defineTool<{
    description: string;
    amount_cents?: number;
    paid_by?: string;
    split_with?: string[];
    shares?: Array<{ person: string; amount_cents: number }>;
    receipt_id?: string;
    items?: Array<{ item: number; people: string[] }>;
    booking_id?: string;
  }>({
    name: "record_expense",
    description:
      "Add something someone paid for to the group's tab. paid_by: who paid (default the caller). Split one way: split_with (names, split " +
      "evenly; default everyone in the group; include the payer if they share it, leave them out for 'Jake owes me $40'), shares (exact " +
      "amounts per person), or a receipt (receipt_id from split_receipt, with items: which people had which item numbers; unassigned items " +
      "and tax/tip are shared). booking_id adds a booking's saved deposit. Amounts in cents. Confirm in one short line without listing what " +
      "each person owes (that's private; send_balances sends it).",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        amount_cents: { type: "integer", minimum: 1 },
        paid_by: { type: "string" },
        split_with: { type: "array", items: { type: "string" } },
        shares: {
          type: "array",
          items: { type: "object", properties: { person: { type: "string" }, amount_cents: { type: "integer", minimum: 0 } }, required: ["person", "amount_cents"], additionalProperties: false },
        },
        receipt_id: { type: "string" },
        items: {
          type: "array",
          items: { type: "object", properties: { item: { type: "integer" }, people: { type: "array", items: { type: "string" } } }, required: ["item", "people"], additionalProperties: false },
        },
        booking_id: { type: "string" },
      },
      required: ["description"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const group = await groupOf(ctx);
      let payer = input.paid_by ? resolveMember(ctx, input.paid_by).userId : ctx.caller.userId;
      let amount = input.amount_cents;
      let source = "manual";
      let sourceId: string | null = null;
      let receiptId: string | null = null;
      let shares: Share[];

      if (input.booking_id) {
        const booking = await store.getBooking(input.booking_id);
        if (!booking || booking.groupId !== group.id) throw new ToolError("That booking isn't in this group.");
        const deposit = booking.confirmation.depositCents;
        if (typeof deposit !== "number" || deposit <= 0) throw new ToolError("That booking has no deposit saved.");
        amount ??= deposit;
        if (!input.paid_by && typeof booking.confirmation.depositPaidByUserId === "string") payer = booking.confirmation.depositPaidByUserId;
        source = "booking_deposit";
        sourceId = booking.id;
      }

      if (input.receipt_id) {
        const receipt = await store.getReceipt(input.receipt_id);
        if (!receipt || receipt.groupId !== group.id) throw new ToolError("That receipt isn't in this group.");
        if (amount !== undefined && amount !== receipt.parsed.totalCents) throw new ToolError(`The receipt's total is ${money(receipt.parsed.totalCents)}.`);
        amount = receipt.parsed.totalCents;
        const assignments = (input.items ?? []).map((a) => ({ item: a.item, people: a.people.map((n) => resolveMember(ctx, n).userId) }));
        shares = wrap(() => receiptSplit(receipt.parsed, assignments, people(ctx, input.split_with)));
        source = "receipt";
        receiptId = receipt.id;
      } else if (input.shares?.length) {
        const exact = input.shares.map((s) => ({ userId: resolveMember(ctx, s.person).userId, amountCents: s.amount_cents }));
        amount ??= exact.reduce((a, s) => a + s.amountCents, 0);
        const total = amount;
        shares = wrap(() => exactSplit(total, exact));
      } else {
        if (amount === undefined) throw new ToolError("How much was it? Pass amount_cents.");
        const total = amount;
        shares = wrap(() => equalSplit(total, people(ctx, input.split_with)));
      }
      if (amount > MAX_ENTRY_CENTS) throw new ToolError(`That's more than ${money(MAX_ENTRY_CENTS)}; double-check the amount.`);

      const entry = await store.createLedgerEntry({
        groupId: group.id,
        payerUserId: payer,
        amountCents: amount,
        currency: "USD",
        description: input.description.trim().slice(0, 80) || "Expense",
        kind: "expense",
        source,
        sourceId,
        receiptId,
        createdByUserId: ctx.caller.userId,
        shares,
      });
      if (!entry) throw new ToolError("That's already on the tab.");
      logger.info("tab.expense", { entryId: entry.id, source });
      const even = !input.shares?.length && !(source === "receipt" && input.items?.length);
      return {
        entry_id: entry.id,
        added: `${nameIn(ctx.members, payer)} paid ${money(amount)} for ${entry.description}`,
        split: even ? `split ${shares.length} way${shares.length === 1 ? "" : "s"}` : "split by what each person had",
        note: "Don't list what each person owes in the group.",
      };
    },
  });

  const splitReceipt = defineTool<{ image_url?: string }>({
    name: "split_receipt",
    description:
      "Read a receipt photo someone posted (the one on the message you're answering, or the latest photo in the last 30 minutes). Returns " +
      "numbered items and the total. Then ask in one short message whether to split evenly or who had what, and call record_expense with the receipt_id.",
    inputSchema: { type: "object", properties: { image_url: { type: "string" } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      const group = await groupOf(ctx);
      let url = input.image_url ?? ctx.mediaUrls?.[0];
      if (!url) {
        const recent = await store.recentMedia(group.id, new Date(now().getTime() - RECENT_PHOTO_MINUTES * 60_000));
        url = (recent.find((m) => m.senderUserId === ctx.caller.userId) ?? recent[0])?.url;
      }
      if (!url) throw new ToolError("I don't see a receipt photo. Ask them to post one.");
      const parsed = await deps.receiptReader(url);
      if (!parsed) throw new ToolError("I couldn't read that as a receipt. Ask for a clearer photo, or the total.");
      const receipt = await store.createReceipt({ groupId: group.id, uploadedByUserId: ctx.caller.userId, imageUrl: url, parsed });
      logger.info("tab.receipt_read", { receiptId: receipt.id, items: parsed.items.length });
      return {
        receipt_id: receipt.id,
        merchant: parsed.merchant,
        items: parsed.items.map((i, n) => `${n + 1}. ${i.name} ${money(i.cents, parsed.currency)}`),
        tax_tip_and_fees: money(parsed.extrasCents, parsed.currency),
        total: money(parsed.totalCents, parsed.currency),
      };
    },
  });

  const undoExpense = defineTool<{ entry_id: string }>({
    name: "undo_expense",
    description: "Take an entry off the tab when it was wrong or added twice. Only whoever added it or paid it can. Then confirm briefly.",
    inputSchema: { type: "object", properties: { entry_id: { type: "string" } }, required: ["entry_id"], additionalProperties: false },
    async run({ entry_id }, ctx) {
      const group = await groupOf(ctx);
      const entry = await store.getLedgerEntry(entry_id);
      if (!entry || entry.groupId !== group.id || entry.voidedAt) throw new ToolError("That entry isn't on this group's tab.");
      if (entry.createdByUserId !== ctx.caller.userId && entry.payerUserId !== ctx.caller.userId) {
        throw new ToolError("Only whoever added it or paid it can take it off the tab.");
      }
      if (entry.source === "settle_up") throw new ToolError("Payments made through Nod can't be taken off the tab.");
      await store.voidLedgerEntry(entry.id);
      return `Took “${entry.description}” off the tab.`;
    },
  });

  const recordPayment = defineTool<{ from: string; amount_cents: number }>({
    name: "record_payment",
    description:
      "Record that someone paid the caller back outside Nod (cash, Venmo). Only the person who received the money can record it: if the " +
      "payer says they paid, ask the recipient to confirm (expect_answer_from) and record it when they do.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, amount_cents: { type: "integer", minimum: 1 } },
      required: ["from", "amount_cents"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const group = await groupOf(ctx);
      const from = resolveMember(ctx, input.from);
      if (from.userId === ctx.caller.userId) throw new ToolError("They can't pay themselves back.");
      if (input.amount_cents > MAX_ENTRY_CENTS) throw new ToolError("That amount looks too big; double-check it.");
      await store.createLedgerEntry({
        groupId: group.id,
        payerUserId: from.userId,
        amountCents: input.amount_cents,
        currency: "USD",
        description: "Paid back",
        kind: "settlement",
        source: "outside",
        sourceId: null,
        receiptId: null,
        createdByUserId: ctx.caller.userId,
        shares: [{ userId: ctx.caller.userId, amountCents: input.amount_cents }],
      });
      return `Recorded that ${displayName(from)} paid ${ctx.caller.name} back. Confirm in a few words without the amount.`;
    },
  });

  async function balanceLines(groupId: string) {
    const [entries, members] = await Promise.all([store.listLedger(groupId), store.groupMembers(groupId)]);
    const b = balances(entries);
    return { entries, members, b, transfers: settleTransfers(b) };
  }

  function personalNote(userId: string, b: Map<string, number>, transfers: Transfer[], members: ChatMember[], groupName: string): string {
    const v = b.get(userId) ?? 0;
    const pays = transfers.filter((t) => t.from === userId).map((t) => `pay ${nameIn(members, t.to)} ${money(t.amountCents)}`);
    const gets = transfers.filter((t) => t.to === userId).map((t) => `${nameIn(members, t.from)} pays you ${money(t.amountCents)}`);
    const head = v > 0 ? `you're owed ${money(v)}` : v < 0 ? `you owe ${money(-v)}` : "you're even";
    const how = [...pays, ...gets];
    return `Your balance on the ${groupName} tab: ${head}.${how.length ? ` To settle: ${how.join("; ")}.` : ""}`;
  }

  const sendBalances = defineTool<Record<string, never>>({
    name: "send_balances",
    description:
      "Privately text each person in the group their own balance on the tab and who they'd pay to settle. Use when someone asks what the " +
      "tab is or what they owe. Then say in the group, in a few words, that everyone got their balance privately.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_input, ctx) {
      const group = await groupOf(ctx);
      const { entries, members, b, transfers } = await balanceLines(group.id);
      if (!entries.length) return "The tab is empty. Say so.";
      let sent = 0;
      for (const m of members) {
        const v = b.get(m.userId) ?? 0;
        if (v === 0 && m.userId !== ctx.caller.userId) continue;
        await provider.send({ phone: m.phone }, { text: personalNote(m.userId, b, transfers, members, group.name ?? "group") });
        sent++;
      }
      const total = entries.filter((e) => e.kind === "expense").reduce((a, e) => a + e.amountCents, 0);
      return `Sent ${sent} people their balance privately. The tab has ${money(total)} in expenses. Don't post anyone's balance in the group.`;
    },
  });

  const settleUp = defineTool<{ hours?: number }>({
    name: "settle_up",
    description:
      "Settle the group's tab: works out the fewest payments that clear everyone's balance, and privately sends each person who owes money " +
      "their pay link (or who to pay, when card payments aren't set up). Nod posts the group message itself; after it succeeds, end your turn without writing anything.",
    inputSchema: { type: "object", properties: { hours: { type: "number", description: "Deadline for card payments; default 48." } }, required: [], additionalProperties: false },
    async run(input, ctx) {
      const group = await groupOf(ctx);
      const { members, b, transfers } = await balanceLines(group.id);
      if (!transfers.length) return "Everyone's even (or owes less than $1). Say so briefly.";
      const payments = deps.payments();
      const name = group.name ?? "group";

      if (payments) {
        const open = (await store.listCollections(group.id)).filter((c) => c.purpose === "settle_up" && (c.status === "setup" || c.status === "collecting"));
        if (open.length) throw new ToolError("A settle-up is already under way. Wait for it to finish or have the people collecting cancel theirs.");
        const hours = Math.min(6 * 24, Math.max(1, input.hours ?? SETTLE_HOURS));
        const deadlineAt = new Date(now().getTime() + hours * HOUR);
        const byCreditor = new Map<string, Array<{ userId: string; amountCents: number }>>();
        for (const t of transfers) byCreditor.set(t.to, [...(byCreditor.get(t.to) ?? []), { userId: t.from, amountCents: t.amountCents }]);
        for (const [creditor, shares] of byCreditor) {
          await payments.startCollection({ group, payeeUserId: creditor, description: `the ${name} tab`, shares, deadlineAt, members, purpose: "settle_up", announce: false });
        }
        await provider.send(
          { groupId: group.providerGroupId },
          { text: `Settling the tab: ${transfers.length} payment${transfers.length === 1 ? "" : "s"}. I've sent each person who owes money a private link; cards are only charged once each person's payments are in.` },
        );
      } else {
        for (const m of members) {
          if (!transfers.some((t) => t.from === m.userId || t.to === m.userId)) continue;
          await provider.send(
            { phone: m.phone },
            { text: `${personalNote(m.userId, b, transfers, members, name)} When someone pays you, tell me in the group (“@Nod Mike paid me $20”).` },
          );
        }
        await provider.send(
          { groupId: group.providerGroupId },
          { text: `Settling the tab: ${transfers.length} payment${transfers.length === 1 ? "" : "s"}. I've told each of you privately who to pay.` },
        );
      }
      logger.info("tab.settle_up", { groupId: group.id, transfers: transfers.length, viaNod: !!payments });
      return "The settle-up is posted and everyone involved was told privately. End your turn without writing anything.";
    },
  });

  // ---- settle-up payments land on the tab ----

  async function onRequestCaptured(c: PaymentCollection, r: PaymentRequest): Promise<void> {
    if (c.purpose !== "settle_up") return;
    await store.createLedgerEntry({
      groupId: c.groupId,
      payerUserId: r.userId,
      amountCents: r.amountCents,
      currency: c.currency,
      description: "Settled up",
      kind: "settlement",
      source: "settle_up",
      sourceId: r.id,
      receiptId: null,
      createdByUserId: null,
      shares: [{ userId: c.payeeUserId, amountCents: r.amountCents }],
    });
  }

  // ---- context ----

  function entryLine(e: LedgerEntryWithShares, members: ChatMember[]): string {
    if (e.kind === "settlement") return `[entry ${e.id}] ${nameIn(members, e.payerUserId)} paid ${nameIn(members, e.shares[0]?.userId ?? "")} back`;
    return `[entry ${e.id}] ${e.description} · ${nameIn(members, e.payerUserId)} paid ${money(e.amountCents)} · shared by ${e.shares.length}`;
  }

  const section: ContextSection = async (call) => {
    if (call.groupId) {
      const [entries, members] = await Promise.all([store.listLedger(call.groupId), store.groupMembers(call.groupId)]);
      if (!entries.length) return null;
      const total = entries.filter((e) => e.kind === "expense").reduce((a, e) => a + e.amountCents, 0);
      return {
        title: "tab",
        body: [
          `${money(total)} in expenses so far. Latest entries:`,
          ...entries.slice(-8).map((e) => entryLine(e, members)),
          "Never post anyone's balance or share in the group; send_balances texts each person theirs.",
        ].join("\n"),
      };
    }
    const lines: string[] = [];
    for (const g of (await store.groupsForUser(call.senderUserId)).slice(0, 5)) {
      const { entries, members, b, transfers } = await balanceLines(g.id);
      if (!entries.length) continue;
      lines.push(`${g.name ?? "A group"}: ${personalNote(call.senderUserId, b, transfers, members, g.name ?? "group").replace(/^Your balance on the .* tab: /, "")}`);
    }
    return lines.length ? { title: "tab", body: `Their balances:\n${lines.join("\n")}` } : null;
  };

  const tools: NodTool<any>[] = [recordExpense, splitReceipt, undoExpense, recordPayment, sendBalances, settleUp];
  return { tools, section, onRequestCaptured };
}
