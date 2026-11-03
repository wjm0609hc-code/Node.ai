// The running tab (Phase 1 step 11): who paid for what, who owes whom, and
// settling up. Expenses come from people telling Nod ("I paid $180 for
// groceries"), receipt photos, and booking deposits; settling up uses the
// step 10 payment flow when payments are set up, or tells people who to pay.
//
// How it should feel: one message. Whoever posts a receipt paid it, everything is
// split evenly across the group unless someone says otherwise, and when someone asks
// for the tab, tab_summary posts the total and who pays whom in the group (rule 3
// covers reminders and nudges, which stay private). Nobody gets a private text about
// the tab unless they ask for one.

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
import { parseVenmoHandle, venmoPayLink } from "./venmo";

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
/** Receipt photos posted this recently, and not read yet, are picked up when someone asks Nod to split. */
const RECENT_PHOTO_HOURS = 12;
/** Receipts read in one go. */
const MAX_RECEIPTS = 4;
/** Expenses listed by name in a summary before "and N more". */
const SUMMARY_ITEMS = 5;

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
      "and tax/tip are shared). booking_id adds a booking's saved deposit. Amounts in cents. Record what people have already said " +
      "(\"$324 was mine\", \"Brian paid for drinks, $324\") without asking them to confirm. Then call tab_summary rather than writing your own numbers.",
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
      };
    },
  });

  const splitReceipt = defineTool<{ image_url?: string; paid_by?: string; split_with?: string[] }>({
    name: "split_receipt",
    description:
      "Read the receipt photos people posted and put each on the tab right away: paid by whoever posted the photo (unless paid_by says " +
      "otherwise), split evenly across everyone in the group (or split_with). It reads the photo on the message you're answering, else every " +
      "photo from the last 12 hours not already on the tab. Don't ask who paid or whether to split evenly; those are the defaults. If someone " +
      "later says who had which items, undo_expense the entry and call record_expense with receipt_id and items.",
    inputSchema: {
      type: "object",
      properties: { image_url: { type: "string" }, paid_by: { type: "string" }, split_with: { type: "array", items: { type: "string" } } },
      required: [],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const group = await groupOf(ctx);
      const photos: Array<{ url: string; senderUserId: string | null }> = [];
      if (input.image_url) photos.push({ url: input.image_url, senderUserId: ctx.caller.userId });
      else if (ctx.mediaUrls?.length) photos.push(...ctx.mediaUrls.map((url) => ({ url, senderUserId: ctx.caller.userId })));
      else {
        const recent = await store.recentMedia(group.id, new Date(now().getTime() - RECENT_PHOTO_HOURS * HOUR));
        for (const m of [...recent].reverse()) if (!(await store.receiptByImage(group.id, m.url))) photos.push(m);
        if (!photos.length && recent.length) return "Every recent photo is already on the tab. Call tab_summary if they want the totals.";
      }
      if (!photos.length) throw new ToolError("No receipt photo here. Ask them to post one, or to say the total.");

      const members = ctx.members.map((m) => m.userId);
      const results = [];
      for (const photo of photos.slice(0, MAX_RECEIPTS)) {
        const existing = await store.receiptByImage(group.id, photo.url);
        if (existing && !input.image_url) continue;
        const parsed = await deps.receiptReader(photo.url);
        if (!parsed) {
          results.push({ unreadable: true, note: "Couldn't read one photo as a receipt; ask for a clearer photo or its total." });
          continue;
        }
        const receipt = await store.createReceipt({ groupId: group.id, uploadedByUserId: photo.senderUserId, imageUrl: photo.url, parsed });
        const payer = input.paid_by
          ? resolveMember(ctx, input.paid_by).userId
          : photo.senderUserId && members.includes(photo.senderUserId)
            ? photo.senderUserId
            : ctx.caller.userId;
        const shares = wrap(() => receiptSplit(parsed, [], people(ctx, input.split_with)));
        const entry = await store.createLedgerEntry({
          groupId: group.id,
          payerUserId: payer,
          amountCents: parsed.totalCents,
          currency: "USD",
          description: (parsed.merchant ?? "Receipt").slice(0, 80),
          kind: "expense",
          source: "receipt",
          sourceId: receipt.id,
          receiptId: receipt.id,
          createdByUserId: ctx.caller.userId,
          shares,
        });
        logger.info("tab.receipt_read", { receiptId: receipt.id, items: parsed.items.length });
        results.push({
          receipt_id: receipt.id,
          entry_id: entry?.id,
          added: `${parsed.merchant ?? "Receipt"} ${money(parsed.totalCents, parsed.currency)}, paid by ${nameIn(ctx.members, payer)}, split ${shares.length} ways`,
          items: parsed.items.slice(0, 30).map((it, n) => `${n + 1}. ${it.name} ${money(it.cents, parsed.currency)}`),
        });
      }
      return { receipts: results, next: "If they asked for the split or a summary, call tab_summary now. Otherwise confirm in one short line." };
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
      "Record that someone paid the caller back outside Nod (cash, Venmo). Only the person who received the money can record it; if the " +
      "payer says they paid, just tell them the person they paid can confirm with \"@Nod got it\".",
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
      return `Recorded that ${displayName(from)} paid ${ctx.caller.name} back. Confirm in a few words.`;
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
      "Privately text each person in the group their own balance. Only when someone explicitly asks for private texts; for \"what's the " +
      "tab\", \"who owes who\" or a summary, use tab_summary instead. If it can't reach someone, don't dwell on it.",
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

  /** The tab in one message: total, what it was, each person's share, and who pays whom (with Venmo links where Nod has the handle). */
  async function summaryText(groupId: string, groupName: string | null): Promise<string | null> {
    const { entries, members, transfers } = await balanceLines(groupId);
    const expenses = entries.filter((e) => e.kind === "expense");
    if (!expenses.length) return null;
    const short = (id: string) => {
      const m = members.find((x) => x.userId === id);
      return m ? (m.name ?? `…${m.phone.slice(-4)}`) : "someone";
    };
    const total = expenses.reduce((a, e) => a + e.amountCents, 0);
    const listed = expenses.slice(0, SUMMARY_ITEMS).map((e) => `${e.description} ${money(e.amountCents)} (${short(e.payerUserId)})`);
    if (expenses.length > SUMMARY_ITEMS) listed.push(`${expenses.length - SUMMARY_ITEMS} more`);

    const owed = new Map<string, number>();
    for (const e of expenses) for (const sh of e.shares) owed.set(sh.userId, (owed.get(sh.userId) ?? 0) + sh.amountCents);
    const shares = [...owed.entries()];
    const amounts = shares.map(([, c]) => c);
    const even = shares.length > 1 && Math.max(...amounts) - Math.min(...amounts) <= shares.length;
    const shareLine = even
      ? `Split ${shares.length} ways: ${money(Math.max(...amounts))} each`
      : `Shares: ${shares.map(([id, c]) => `${short(id)} ${money(c)}`).join(", ")}`;

    const paidBack = entries.filter((e) => e.kind === "settlement").reduce((a, e) => a + e.amountCents, 0);
    const lines = [`${groupName ? `${groupName} tab` : "Tab"}: ${money(total)}`, listed.join(" · "), shareLine + (paidBack ? ` (${money(paidBack)} already paid back)` : "")];
    if (!transfers.length) lines.push("Everyone's even.");
    for (const t of transfers) {
      const to = await store.getUser(t.to);
      const link = to?.venmoHandle ? ` ${venmoPayLink(to.venmoHandle, t.amountCents, `${groupName ?? "Group"} tab`)}` : "";
      lines.push(`${short(t.from)} → ${short(t.to)} ${money(t.amountCents)}${link}`);
    }
    return lines.join("\n");
  }

  const tabSummary = defineTool<Record<string, never>>({
    name: "tab_summary",
    description:
      "Post the tab in the group as one message: the total, what it was for, each person's share, and who pays whom how much (with a Venmo " +
      "link when the person being paid saved their Venmo). Use whenever someone asks to split the bill, what the tab is, who owes who, or for " +
      "a summary, after recording any expenses from the chat that aren't on the tab yet. Nod posts it itself; end your turn without writing anything.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_input, ctx) {
      const group = await groupOf(ctx);
      const text = await summaryText(group.id, group.name);
      if (!text) return "The tab is empty. Say so in a few words, and that a receipt photo or \"I paid $X for Y\" adds to it.";
      await provider.send({ groupId: group.providerGroupId }, { text });
      logger.info("tab.summary", { groupId: group.id });
      return "Posted the summary. End your turn without writing anything.";
    },
  });

  const setMemberName = defineTool<{ people: Array<{ person: string; name: string }> }>({
    name: "set_member_name",
    description:
      "Save names for members Nod only knows by number (\"Brian is 6249\", \"2014 is Peter\"), or when it's obvious from the chat who " +
      "someone is. person is how they appear now (\"Member ending 6249\" or \"6249\"). Names stick across every chat. Members can only be " +
      "renamed by themselves once they have a name.",
    inputSchema: {
      type: "object",
      properties: {
        people: {
          type: "array",
          items: { type: "object", properties: { person: { type: "string" }, name: { type: "string" } }, required: ["person", "name"], additionalProperties: false },
        },
      },
      required: ["people"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const done: string[] = [];
      for (const p of input.people.slice(0, 12)) {
        const m = resolveMember(ctx, p.person);
        const name = p.name.trim().replace(/\s+/g, " ").slice(0, 40);
        if (!name || /\d{3}/.test(name)) throw new ToolError(`“${p.name}” doesn't look like a name.`);
        if (m.name && m.userId !== ctx.caller.userId) throw new ToolError(`${m.name} already has a name; only they can change it.`);
        await store.setUserName(m.userId, name);
        m.name = name; // later tools in this turn see it
        done.push(`${m.phone.slice(-4)} is ${name}`);
      }
      return `Saved: ${done.join(", ")}.`;
    },
  });

  const saveVenmo = defineTool<{ handle: string }>({
    name: "save_venmo",
    description:
      "Save the caller's own Venmo username (\"my venmo is @will-m\", or they posted their venmo.com link), so tab summaries link straight " +
      "to Venmo with the amount filled in. Only for the caller's own account, never someone else's.",
    inputSchema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"], additionalProperties: false },
    async run({ handle }, ctx) {
      const parsed = parseVenmoHandle(handle);
      if (!parsed) throw new ToolError("That doesn't look like a Venmo username.");
      await store.setVenmoHandle(ctx.caller.userId, parsed);
      return `Saved ${ctx.caller.name}'s Venmo as @${parsed}. Confirm in a few words.`;
    },
  });

  const settleUp = defineTool<{ hours?: number }>({
    name: "settle_up",
    description:
      "Collect the tab through Nod's card payments: works out the fewest payments and privately sends each person who owes money a pay " +
      "link. Only when someone asks Nod to collect the money; for who owes who, use tab_summary. Nod posts the group message itself; end your turn without writing anything.",
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
        const text = await summaryText(group.id, group.name);
        if (text) await provider.send({ groupId: group.providerGroupId }, { text }); // who pays whom, in the group
      }
      logger.info("tab.settle_up", { groupId: group.id, transfers: transfers.length, viaNod: !!payments });
      return payments ? "The settle-up is posted and pay links went out privately. End your turn without writing anything." : "Posted who pays whom. End your turn without writing anything.";
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
          "For the split, the tab, who owes who or a summary: record anything from the chat that's missing, then tab_summary.",
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

  const tools: NodTool<any>[] = [recordExpense, splitReceipt, tabSummary, setMemberName, saveVenmo, undoExpense, recordPayment, sendBalances, settleUp];
  return { tools, section, onRequestCaptured };
}
