import { describe, expect, it } from "vitest";
import { buildBookingLink } from "./links";

const dinner = { partySize: 6, date: "2026-10-03", time: "20:00" };
const stay = { partySize: 6, checkIn: "2027-03-14", checkOut: "2027-03-18" };

describe("buildBookingLink", () => {
  it.each([
    ["https://www.opentable.com/r/hartwood-tulum", dinner, "https://www.opentable.com/r/hartwood-tulum?covers=6&dateTime=2026-10-03T20%3A00"],
    ["https://resy.com/cities/tulum/venues/arca", dinner, "https://resy.com/cities/tulum/venues/arca?date=2026-10-03&seats=6"],
    ["https://www.exploretock.com/arca-tulum", dinner, "https://www.exploretock.com/arca-tulum/search?date=2026-10-03&size=6&time=20%3A00"],
    ["https://www.airbnb.com/rooms/111", stay, "https://www.airbnb.com/rooms/111?adults=6&check_in=2027-03-14&check_out=2027-03-18"],
    ["https://www.vrbo.com/3456789", stay, "https://www.vrbo.com/3456789?adults=6&endDate=2027-03-18&startDate=2027-03-14"],
    ["https://www.booking.com/hotel/mx/casa.html", stay, "https://www.booking.com/hotel/mx/casa.html?checkin=2027-03-14&checkout=2027-03-18&group_adults=6"],
  ])("%s", (url, details, expected) => {
    expect(buildBookingLink(url, details)).toEqual({ url: expected, prefilled: true, platform: expect.any(String) });
  });

  it("replaces existing dates and guest counts instead of duplicating them", () => {
    const out = buildBookingLink("https://www.airbnb.com/rooms/111?adults=2&check_in=2027-01-01", stay);
    expect(out.url).toBe("https://www.airbnb.com/rooms/111?adults=6&check_in=2027-03-14&check_out=2027-03-18");
  });

  it("returns other links unchanged and says so", () => {
    expect(buildBookingLink("https://hartwoodtulum.com/", dinner)).toEqual({ url: "https://hartwoodtulum.com/", prefilled: false });
  });

  it("doesn't fill a rental link without dates, or a restaurant link without a time", () => {
    expect(buildBookingLink("https://www.airbnb.com/rooms/111", { partySize: 6 }).prefilled).toBe(false);
    expect(buildBookingLink("https://resy.com/cities/tulum/venues/arca", { partySize: 6 }).prefilled).toBe(false);
  });

  it("refuses non-web links", () => {
    expect(() => buildBookingLink("javascript:alert(1)", dinner)).toThrow();
  });
});
