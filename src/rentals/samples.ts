// Sample listing pages for the web simulator, which can't reach the internet.
// Every sample is labelled "(sample)" so it can't be mistaken for a real listing.

import type { ListingFetcher } from "./rentals";
import { normalizeListingUrl } from "./listing";

export const SAMPLE_LISTINGS = [
  {
    url: "https://www.airbnb.com/rooms/111",
    label: "Casa Azul (Airbnb)",
    html: `<meta property="og:title" content="Casa Azul (sample) · Condo in Tulum · ★4.92 · 3 bedrooms · 4 beds · 2 baths">
<meta property="og:description" content="Rooftop pool, 5 minutes to the beach. Sleeps 8 guests. Free cancellation before Mar 1.">`,
  },
  {
    url: "https://www.airbnb.com/rooms/222",
    label: "Jungle Loft (Airbnb)",
    html: `<meta property="og:title" content="Jungle Loft (sample) · Loft in Tulum · ★4.85 · 2 bedrooms · 3 beds · 1 bath">
<meta property="og:description" content="Treehouse-style loft with a plunge pool. Sleeps 5 guests. $240 per night. Non-refundable.">`,
  },
  {
    url: "https://www.vrbo.com/3456789",
    label: "Beach House (Vrbo)",
    html: `<meta property="og:title" content="Beach House with Private Pool (sample)"><script type="application/ld+json">{"@type":"VacationRental","name":"Beach House with Private Pool (sample)","address":{"addressLocality":"Tulum"},"containsPlace":{"occupancy":{"maxValue":10},"numberOfBedrooms":4,"numberOfBathroomsTotal":3},"aggregateRating":{"ratingValue":4.7},"offers":{"price":"425","priceCurrency":"USD","unitText":"night"}}</script>`,
  },
];

export const sampleListingFetcher: ListingFetcher = async (url) => {
  const sample = SAMPLE_LISTINGS.find((s) => normalizeListingUrl(s.url) === normalizeListingUrl(url));
  if (!sample) throw new Error("the simulator can't reach the internet; only the sample links work here");
  return sample.html;
};
