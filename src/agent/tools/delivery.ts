// delivery_link: a deep link into a delivery app with the search filled in. Not an
// order: whoever opens it orders and pays in the app (Nod never pays or holds money).

import { affiliateLink } from "../../affiliates/affiliates";
import { defineTool, ToolError } from "../tools";

export const DELIVERY_SERVICES = ["doordash", "ubereats", "instacart", "grubhub"] as const;
export type DeliveryService = (typeof DELIVERY_SERVICES)[number];

const NAMES: Record<DeliveryService, string> = { doordash: "DoorDash", ubereats: "Uber Eats", instacart: "Instacart", grubhub: "Grubhub" };

/** Search links from each service's public site (to verify against their docs before launch). */
export function deliveryUrl(service: DeliveryService, query: string): string {
  const q = encodeURIComponent(query.trim());
  switch (service) {
    case "doordash":
      return `https://www.doordash.com/search/store/${q}/`;
    case "ubereats":
      return `https://www.ubereats.com/search?q=${q}`;
    case "instacart":
      return `https://www.instacart.com/store/s?k=${q}`;
    case "grubhub":
      return `https://www.grubhub.com/search?queryText=${q}`;
  }
}

export const deliveryLink = defineTool<{ service: DeliveryService; items: string[]; store?: string; address?: string }>({
  name: "delivery_link",
  description:
    "A link into a delivery app (DoorDash, Uber Eats, Instacart, Grubhub) with the search filled in, when someone asks to get food or supplies " +
    "delivered. It is not an order: whoever opens it orders and pays in the app. The address can't be filled in, so mention it if given. " +
    "Reply in one line with the link and the items; offer to add the cost to the tab once someone has ordered.",
  inputSchema: {
    type: "object",
    properties: {
      service: { type: "string", enum: [...DELIVERY_SERVICES] },
      items: { type: "array", items: { type: "string" }, description: "What they asked for, e.g. ['2 bags of ice', 'limes']." },
      store: { type: "string", description: "A restaurant or store name if they named one." },
      address: { type: "string", description: "Where it's going, if they said." },
    },
    required: ["service", "items"],
    additionalProperties: false,
  },
  async run({ service, items, store, address }) {
    const list = items.map((i) => i.trim()).filter(Boolean).slice(0, 20);
    const query = store?.trim() || list.join(", ");
    if (!query) throw new ToolError("What should be delivered, or from where?");
    const url = affiliateLink(deliveryUrl(service, query.slice(0, 120)));
    return [
      `${NAMES[service]} link: ${url}`,
      list.length ? `Items to add: ${list.join(", ")}.` : null,
      address?.trim() ? `Set the delivery address in the app: ${address.trim()}.` : null,
      "Not an order yet: whoever opens it orders and pays.",
    ]
      .filter(Boolean)
      .join(" ");
  },
});
