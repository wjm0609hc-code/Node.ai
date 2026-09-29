import { describe, expect, it } from "vitest";
import { formatRentalCard, isRentalUrl, missingFields, normalizeListingUrl, parseListingHtml, type Listing } from "./listing";

const airbnb = `<!doctype html><html><head>
<title>Condo in Tulum · ★4.92 · 2 bedrooms · 3 beds · 2 baths - Airbnb</title>
<meta property="og:title" content="Casa Azul · Condo in Tulum · ★4.92 · 2 bedrooms · 3 beds · 2 baths">
<meta content="https://a0.muscache.com/im/pictures/casa-azul.jpg" property="og:image" />
<meta property="og:description" content="Rooftop pool, 5 min to the beach. Sleeps 6 guests. Free cancellation before Mar 1.">
<meta property="og:url" content="https://www.airbnb.com/rooms/111">
</head><body></body></html>`;

const vrbo = `<html><head><meta property="og:title" content="Beach House w/ Private Pool &amp; Chef&#39;s Kitchen"/>
<meta property="og:image" content="https://images.trvl-media.com/beach.jpg"/></head><body>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"VacationRental","name":"Beach House w/ Private Pool","address":{"addressLocality":"Tulum","addressRegion":"Quintana Roo"},
"containsPlace":{"@type":"Accommodation","occupancy":{"@type":"QuantitativeValue","maxValue":10},"numberOfBedrooms":4,"numberOfBathroomsTotal":3},
"aggregateRating":{"ratingValue":4.8},"offers":{"@type":"Offer","price":"425.00","priceCurrency":"USD","unitText":"night"}}</script>
</body></html>`;

const generic = `<html><head><title>Villa Luna | Tulum Jungle Villas</title>
<meta name="description" content="3 bedroom villa, $1,550 total for 5 nights. Non-refundable."></head></html>`;

describe("parseListingHtml", () => {
  it("reads Airbnb-style Open Graph tags", () => {
    expect(parseListingHtml("https://www.airbnb.com/rooms/111", airbnb)).toMatchObject({
      title: "Casa Azul",
      photoUrl: "https://a0.muscache.com/im/pictures/casa-azul.jpg",
      site: "Airbnb",
      location: "Tulum",
      rating: 4.92,
      bedrooms: 2,
      beds: 3,
      baths: 2,
      sleeps: 6,
      cancellation: "Free cancellation before Mar 1",
    });
  });

  it("reads schema.org JSON-LD (VRBO-style), including price in cents", () => {
    expect(parseListingHtml("https://www.vrbo.com/12345", vrbo)).toMatchObject({
      title: "Beach House w/ Private Pool",
      site: "Vrbo",
      location: "Tulum",
      sleeps: 10,
      bedrooms: 4,
      baths: 3,
      rating: 4.8,
      price: { amountCents: 42500, currency: "USD", per: "night" },
    });
  });

  it("falls back to <title> and description text", () => {
    expect(parseListingHtml("https://tulumjunglevillas.com/luna", generic)).toMatchObject({
      title: "Villa Luna",
      site: "tulumjunglevillas.com",
      bedrooms: 3,
      price: { amountCents: 155000, currency: "USD", per: "total" },
      cancellation: "Non-refundable",
    });
  });

  it.each([
    ["$310 per night", { amountCents: 31000, currency: "USD", per: "night" }],
    ["$310/night", { amountCents: 31000, currency: "USD", per: "night" }],
    ["MX$5,200 night", { amountCents: 520000, currency: "MXN", per: "night" }],
    ["€180 / night", { amountCents: 18000, currency: "EUR", per: "night" }],
    ["$1,234.50 total", { amountCents: 123450, currency: "USD", per: "total" }],
  ])("price text %j", (text, price) => {
    expect(parseListingHtml("https://x.test/a", `<meta name="description" content="${text}">`).price).toEqual(price);
  });

  it("returns what it can from an empty page", () => {
    expect(parseListingHtml("https://www.airbnb.com/rooms/999", "")).toEqual({ site: "Airbnb" });
  });
});

describe("normalizeListingUrl", () => {
  it.each([
    ["https://www.airbnb.com/rooms/111?source_impression_id=p3&check_in=2027-03-14&adults=6#photos", "https://www.airbnb.com/rooms/111?adults=6&check_in=2027-03-14"],
    ["https://airbnb.com/rooms/111", "https://www.airbnb.com/rooms/111"],
    ["http://WWW.VRBO.com/12345?utm_source=ig&fbclid=abc", "https://www.vrbo.com/12345"],
    ["https://abnb.me/xyz", "https://abnb.me/xyz"],
  ])("%s", (raw, norm) => {
    expect(normalizeListingUrl(raw)).toBe(norm);
  });

  it("rejects non-web links", () => {
    expect(normalizeListingUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeListingUrl("ftp://x.test/a")).toBeNull();
    expect(normalizeListingUrl("not a url")).toBeNull();
  });
});

describe("isRentalUrl", () => {
  it.each([
    "https://www.airbnb.com/rooms/111",
    "https://www.airbnb.co.uk/rooms/5",
    "https://abnb.me/xyz",
    "https://www.vrbo.com/12345",
    "https://www.booking.com/hotel/mx/casa.html",
    "https://www.plumguide.com/homes/1",
  ])("yes: %s", (url) => expect(isRentalUrl(url)).toBe(true));

  it.each(["https://www.airbnb.com/experiences/1", "https://youtube.com/watch?v=1", "https://nod.example/x"])("no: %s", (url) =>
    expect(isRentalUrl(url)).toBe(false),
  );
});

describe("cards", () => {
  const full: Listing = {
    title: "Casa Azul",
    site: "Airbnb",
    location: "Tulum",
    price: { amountCents: 31000, currency: "USD", per: "night" },
    sleeps: 6,
    bedrooms: 2,
    rating: 4.92,
    cancellation: "Free cancellation before Mar 1",
  };

  it("formats one short line", () => {
    expect(formatRentalCard(full, "https://www.airbnb.com/rooms/111")).toBe(
      "Casa Azul, Tulum · $310/night · sleeps 6 · 2 BR · ★4.92 · Free cancellation before Mar 1 · airbnb.com/rooms/111",
    );
  });

  it("formats other currencies and totals", () => {
    expect(formatRentalCard({ title: "Loft", price: { amountCents: 520000, currency: "MXN", per: "total" } }, "https://x.test/l")).toBe(
      "Loft · MXN 5,200 total · x.test/l",
    );
  });

  it("names missing fields, in the order people care about", () => {
    expect(missingFields(full)).toEqual([]);
    expect(missingFields({ title: "Loft", bedrooms: 1 })).toEqual(["price", "sleeps", "cancellation policy"]);
  });
});
