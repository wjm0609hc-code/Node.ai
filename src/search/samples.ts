// Sample search results for the web simulator, which can't reach the internet.
// Every pick is labelled "(sample)" and links to example.com.

import type { Searcher } from "./picks";

export const sampleSearcher: Searcher = async () => ({
  picks: [
    { name: "Rooftop salsa night (sample)", kind: "activity", summary: "Live band and dancing on a rooftop", url: "https://example.com/sample/salsa", when: "Saturday from 9pm", priceHint: "$15 cover" },
    { name: "Taquería Late (sample)", kind: "restaurant", summary: "Tacos al pastor until 2am", url: "https://example.com/sample/tacos", when: "Open until 2am", priceHint: "$" },
    { name: "Beach bonfire party (sample)", kind: "event", summary: "DJ and bonfire on the beach", url: "https://example.com/sample/bonfire", when: "Saturday 8pm–1am", priceHint: "$25" },
    { name: "Cenote night swim (sample)", kind: "activity", summary: "Guided swim with lanterns", url: "https://example.com/sample/cenote", when: "Saturday 7pm", priceHint: "$40 per person" },
    { name: "Wood-fire dinner (sample)", kind: "restaurant", summary: "Set menu cooked over open fire", url: "https://example.com/sample/woodfire", when: "Seatings 6–10pm", priceHint: "$$$" },
  ],
});
