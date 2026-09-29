import { describe, expect, it } from "vitest";
import { renderSearchPage } from "./page";

describe("renderSearchPage", () => {
  it("lists every pick with its link, escaping text", () => {
    const html = renderSearchPage({
      query: "fun <things> to do",
      location: "Tulum",
      whenText: "Saturday evening",
      createdAt: new Date("2026-09-29T15:00:00Z"),
      results: {
        picks: [
          { name: "Batey & Co", kind: "activity", summary: "Live salsa", url: "https://batey.mx/", when: "From 9pm", priceHint: "$" },
          { name: "Hartwood", kind: "restaurant", summary: "Wood-fired", url: "https://hartwoodtulum.com/" },
        ],
      },
    });
    expect(html).toContain("<title>Nod search: fun &lt;things&gt; to do</title>");
    expect(html).toContain("Batey &amp; Co");
    expect(html).toContain('href="https://batey.mx/"');
    expect(html).toContain("Tulum · Saturday evening");
    expect(html).toContain("Searched September 29, 2026");
    expect(html).not.toContain("<things>");
  });

  it("refuses to link anything but http(s)", () => {
    const html = renderSearchPage({
      query: "q",
      location: null,
      whenText: null,
      createdAt: new Date(),
      results: { picks: [{ name: "X", kind: "other", summary: "", url: "javascript:alert(1)" }] },
    });
    expect(html).not.toContain("javascript:");
  });
});
