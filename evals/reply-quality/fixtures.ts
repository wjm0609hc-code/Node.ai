// Fixed search results and starting state for the reply-quality tests. Searches return these
// instead of live web results, so every run sees the same places and the grade measures Nod's
// replies, not what the web had that day. Names are made up; links point at the right kind of
// site (Resy, OpenTable, a venue's own page) so booking links and cards work as in production.

import type { Pick, SearchRequest, Searcher } from "../../src/search/picks";

const r = (name: string, area: string, booking: string, summary: string, price: string, extra: Partial<Pick> = {}): Pick => ({
  name,
  kind: "restaurant",
  summary,
  url: booking,
  bookingUrl: booking,
  area,
  priceHint: price,
  ...extra,
});

const WEST_VILLAGE: Pick[] = [
  r("Bistro Verde", "West Village", "https://resy.com/cities/ny/bistro-verde", "Seasonal Italian, good for groups", "$$$"),
  r("Little Ember", "West Village", "https://www.opentable.com/r/little-ember-new-york", "Wood-fired small plates", "$$"),
  r("Casa Lupita", "West Village", "https://resy.com/cities/ny/casa-lupita", "Mexican, big tables in back", "$$"),
  r("Hudson Oyster Room", "West Village", "https://www.opentable.com/r/hudson-oyster-room", "Seafood and raw bar", "$$$"),
  { name: "Grove Street Noodle", kind: "restaurant", summary: "Hand-pulled noodles, walk-in", url: "https://grovestreetnoodle.com/", website: "https://grovestreetnoodle.com/", area: "West Village", priceHint: "$" },
  r("Perry Table", "West Village", "https://resy.com/cities/ny/perry-table", "New American, private room for 6–10", "$$$"),
  { name: "Corner Trattoria", kind: "restaurant", summary: "Cheap pasta, BYOB", url: "https://cornertrattoria.nyc/", website: "https://cornertrattoria.nyc/", area: "West Village", priceHint: "$" },
  r("Bleecker Bowl", "West Village", "https://resy.com/cities/ny/bleecker-bowl", "Rice bowls and natural wine", "$"),
];

const BARS: Pick[] = [
  r("The Copper Tap", "East Village", "https://resy.com/cities/ny/copper-tap", "Cocktails, booths for groups", "$$"),
  r("Low Tide", "Lower East Side", "https://resy.com/cities/ny/low-tide", "Speakeasy, reservations recommended", "$$$"),
  { name: "Ninth Street Ale House", kind: "restaurant", summary: "Beer hall, big tables, no reservations", url: "https://ninthstreetale.com/", website: "https://ninthstreetale.com/", area: "East Village", priceHint: "$" },
  r("Skyline 22", "Midtown", "https://www.opentable.com/r/skyline-22-new-york", "Rooftop bar with heaters", "$$$"),
  { name: "Mercer Wine Bar", kind: "restaurant", summary: "Natural wine and snacks", url: "https://mercerwine.com/", website: "https://mercerwine.com/", area: "SoHo", priceHint: "$$" },
  r("Bar Lucia", "West Village", "https://resy.com/cities/ny/bar-lucia", "Aperitivo hour 5–7pm", "$$"),
];

const STEAK: Pick[] = [
  r("Iron & Oak", "Midtown", "https://www.opentable.com/r/iron-and-oak-new-york", "Classic steakhouse; roasted vegetable plates and a mushroom main", "$$$$"),
  r("The Butcher's Table", "Midtown East", "https://resy.com/cities/ny/butchers-table", "Dry-aged steaks; several vegetarian sides", "$$$$"),
  r("Prime 48", "Midtown West", "https://www.opentable.com/r/prime-48-new-york", "Steak and seafood; vegetarian tasting menu on request", "$$$$"),
  r("Ember Grill", "Midtown", "https://resy.com/cities/ny/ember-grill", "Argentine grill; grilled vegetables and empanadas", "$$$"),
  r("Madison Chophouse", "Midtown East", "https://www.opentable.com/r/madison-chophouse", "Old-school chophouse", "$$$$"),
  r("Hearth & Cut", "Midtown West", "https://resy.com/cities/ny/hearth-and-cut", "Modern steakhouse; big salads and a veggie burger", "$$$"),
];

const KNICKS: Pick[] = [
  { name: "Knicks vs Celtics", kind: "event", summary: "Madison Square Garden", url: "https://seatgeek.com/knicks-vs-celtics-tickets", bookingUrl: "https://seatgeek.com/knicks-vs-celtics-tickets", when: "Thu 7:30 PM", priceHint: "from $89", area: "Midtown" },
  { name: "Knicks vs Heat", kind: "event", summary: "Madison Square Garden", url: "https://www.ticketmaster.com/knicks-vs-heat", bookingUrl: "https://www.ticketmaster.com/knicks-vs-heat", when: "Sat 8:00 PM", priceHint: "from $112", area: "Midtown" },
  { name: "Knicks vs Bulls", kind: "event", summary: "Madison Square Garden", url: "https://www.stubhub.com/knicks-vs-bulls", bookingUrl: "https://www.stubhub.com/knicks-vs-bulls", when: "Sun 6:00 PM", priceHint: "from $74", area: "Midtown" },
  { name: "Knicks vs 76ers", kind: "event", summary: "Madison Square Garden", url: "https://seatgeek.com/knicks-vs-76ers-tickets", bookingUrl: "https://seatgeek.com/knicks-vs-76ers-tickets", when: "Tue 7:30 PM", priceHint: "from $95", area: "Midtown" },
];

const TULUM: Pick[] = [
  { name: "Cenote Dos Ojos snorkel", kind: "activity", summary: "Guided snorkel in two connected cenotes", url: "https://www.viator.com/tours/Tulum/cenote-dos-ojos", bookingUrl: "https://www.viator.com/tours/Tulum/cenote-dos-ojos", when: "Sat 1:00 PM", priceHint: "$65 per person", area: "Tulum" },
  { name: "Tulum ruins and beach", kind: "activity", summary: "Mayan ruins above the beach, then a swim", url: "https://www.getyourguide.com/tulum-ruins", bookingUrl: "https://www.getyourguide.com/tulum-ruins", when: "Sat 2:00 PM", priceHint: "$45 per person", area: "Tulum" },
  { name: "Sian Ka'an boat tour", kind: "activity", summary: "Lagoon boat ride with dolphins and a reef swim", url: "https://www.viator.com/tours/Tulum/sian-kaan", bookingUrl: "https://www.viator.com/tours/Tulum/sian-kaan", when: "Sat 12:30 PM", priceHint: "$120 per person", area: "Tulum" },
  { name: "Beach club afternoon", kind: "event", summary: "Day beds and a DJ on the beach", url: "https://papayaplaya.com/", website: "https://papayaplaya.com/", when: "Sat from noon", priceHint: "$30 minimum", area: "Tulum Beach" },
  { name: "Bike to Playa Paraíso", kind: "activity", summary: "Rent bikes and ride the coast road", url: "https://tulumbikes.com/", when: "Any time", priceHint: "$15 per bike", area: "Tulum" },
];

/** Picks for what was asked, from the fixed sets above. Anything else gets the West Village dinner set. */
export const fixtureSearcher: Searcher = async (req: SearchRequest) => {
  const q = `${req.query} ${req.location ?? ""} ${(req.preferences ?? []).join(" ")}`.toLowerCase();
  if (/knick|ticket|game/.test(q)) return { picks: KNICKS };
  if (/tulum|cenote|beach/.test(q)) return { picks: TULUM };
  if (/steak/.test(q)) return { picks: STEAK };
  if (/bar|drink|cocktail/.test(q)) return { picks: BARS };
  const cheap = /cheap|budget|inexpensive|affordable|\$\b/.test(q);
  return { picks: cheap ? WEST_VILLAGE.filter((p) => p.priceHint !== "$$$") : WEST_VILLAGE };
};

/** The group's past dinner (the "past_dinner" seed): Lupa in the West Village, about three weeks back. */
export const PAST_DINNER = {
  title: "Lupa",
  area: "West Village",
  url: "https://resy.com/cities/ny/lupa",
  partySize: 5,
  daysAgo: 21,
};
