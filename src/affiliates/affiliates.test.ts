import { describe, expect, it } from "vitest";
import { activePrograms, affiliateLink } from "./affiliates";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("affiliateLink", () => {
  it("leaves links alone when no program is set up", () => {
    expect(affiliateLink("https://www.booking.com/hotel/us/x.html?checkin=2026-10-09", env({}))).toBe("https://www.booking.com/hotel/us/x.html?checkin=2026-10-09");
  });

  it("adds the program's tag to its own links, keeping what's already there", () => {
    const e = env({ NOD_AFFILIATE_BOOKING: "123456" });
    expect(affiliateLink("https://www.booking.com/hotel/us/x.html?checkin=2026-10-09", e)).toBe("https://www.booking.com/hotel/us/x.html?checkin=2026-10-09&aid=123456");
    expect(affiliateLink("https://www.booking.com/hotel/us/x.html?aid=999", e)).toBe("https://www.booking.com/hotel/us/x.html?aid=999"); // someone else's tag stays
    expect(affiliateLink("https://www.viator.com/tours/x", env({ NOD_AFFILIATE_VIATOR: "P0001" }))).toBe("https://www.viator.com/tours/x?pid=P0001");
  });

  it("wraps links for programs that track through a network link ({url} in the setting)", () => {
    const e = env({ NOD_AFFILIATE_EXPEDIA: "https://example.pxf.io/c/1/2/3?u={url}" });
    expect(affiliateLink("https://www.vrbo.com/12345?startDate=2026-10-09", e)).toBe(
      `https://example.pxf.io/c/1/2/3?u=${encodeURIComponent("https://www.vrbo.com/12345?startDate=2026-10-09")}`,
    );
  });

  it("never changes links for other sites, or produces anything but a web link", () => {
    const e = env({ NOD_AFFILIATE_BOOKING: "123456", NOD_AFFILIATE_STUBHUB: "javascript:alert(1)//{url}" });
    expect(affiliateLink("https://www.airbnb.com/rooms/1", e)).toBe("https://www.airbnb.com/rooms/1");
    expect(affiliateLink("https://notbooking.com/x", e)).toBe("https://notbooking.com/x");
    expect(affiliateLink("https://www.stubhub.com/event/1", e)).toBe("https://www.stubhub.com/event/1");
    expect(affiliateLink("not a url", e)).toBe("not a url");
  });

  it("lists the programs that are switched on", () => {
    expect(activePrograms(env({ NOD_AFFILIATE_BOOKING: "1", NOD_AFFILIATE_VIATOR: " " }))).toEqual(["Booking.com"]);
  });
});
