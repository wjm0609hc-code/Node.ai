// show_options: presents rentals or search picks as Nod's product cards, sent right after
// the reply text, numbered when there are several. Each card opens the listing or venue page.

import { defineTool, ToolError, type NodTool } from "../agent/tools";
import { cardForOption } from "../cards/spec";
import type { Option, Store } from "../db/store";

const MAX_CARDS = 5;

export function createShowOptions(deps: { store: Store; refresh?: (o: Option) => Promise<{ option: Option }> }) {
  const showOptions = defineTool<{ option_ids: string[] }>({
    name: "show_options",
    description:
      "Show rentals or places as cards (photo, name, price; tapping one opens its page) after your reply, whenever you present or compare " +
      "options or search results. Pass the options in the order you mention them (at most 5); several are numbered 1, 2, 3 to match. " +
      "Don't paste their links in your reply; the cards carry them. Keep your reply to a line or two that introduces the cards.",
    inputSchema: {
      type: "object",
      properties: { option_ids: { type: "array", items: { type: "string" }, description: "Option ids from the context, in order." } },
      required: ["option_ids"],
      additionalProperties: false,
    },
    async run({ option_ids }, ctx) {
      if (ctx.chat.kind !== "group") throw new ToolError("Cards for saved options are for the group chat; in a private chat, just reply.");
      if (!ctx.cards || !ctx.attachCard) throw new ToolError("Cards aren't available here; describe the options briefly instead.");
      const ids = [...new Set(option_ids)].slice(0, MAX_CARDS);
      const options = [];
      for (const id of ids) {
        const o = await deps.store.getOption(id);
        if (!o || o.groupId !== ctx.chat.groupId) throw new ToolError(`No option ${id} in this chat.`);
        options.push(deps.refresh ? (await deps.refresh(o)).option : o); // read listings nobody asked about yet, so the card has a name, price and photo
      }
      if (!options.length) throw new ToolError("Which options?");
      for (const [i, o] of options.entries()) {
        ctx.attachCard(await ctx.cards.make(ctx.chat.groupId, cardForOption(o, options.length > 1 ? { number: i + 1 } : {})), o.id);
      }
      return `${options.length} card${options.length === 1 ? "" : "s"} will follow your reply${options.length > 1 ? `, numbered 1–${options.length} in this order` : ""}. Don't repeat their links.`;
    },
  });
  const tools: NodTool<any>[] = [showOptions];
  return { tools };
}
