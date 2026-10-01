import { describe, expect, it } from "vitest";
import { deliveryUrl } from "./delivery";

describe("deliveryUrl", () => {
  it("opens a search in each service for the store, else the items", () => {
    expect(deliveryUrl("doordash", "Taqueria Lupita")).toBe("https://www.doordash.com/search/store/Taqueria%20Lupita/");
    expect(deliveryUrl("ubereats", "pad thai & spring rolls")).toBe("https://www.ubereats.com/search?q=pad%20thai%20%26%20spring%20rolls");
    expect(deliveryUrl("instacart", "ice, limes")).toBe("https://www.instacart.com/store/s?k=ice%2C%20limes");
    expect(deliveryUrl("grubhub", "pizza")).toBe("https://www.grubhub.com/search?queryText=pizza");
  });

  it("keeps slashes out of path-based links", () => {
    expect(deliveryUrl("doordash", "50/50 burgers")).toBe("https://www.doordash.com/search/store/50%2F50%20burgers/");
  });
});
