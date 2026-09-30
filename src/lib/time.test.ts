import { describe, expect, it } from "vitest";
import { formatLocal, localDateTimeToUtc, localNowLine, toLocalDateTime } from "./time";

describe("localDateTimeToUtc", () => {
  it.each([
    ["2026-10-02T18:00", "America/New_York", "2026-10-02T22:00:00.000Z"], // EDT
    ["2026-12-02T18:00", "America/New_York", "2026-12-02T23:00:00.000Z"], // EST
    ["2026-10-02T18:00", "America/Cancun", "2026-10-02T23:00:00.000Z"], // no DST
    ["2026-10-02T18:00:00", "UTC", "2026-10-02T18:00:00.000Z"],
    ["2026-03-08T12:30", "America/Los_Angeles", "2026-03-08T19:30:00.000Z"], // day DST starts
  ])("%s in %s", (local, tz, utc) => {
    expect(localDateTimeToUtc(local, tz)!.toISOString()).toBe(utc);
  });

  it("rejects malformed input", () => {
    expect(localDateTimeToUtc("Friday 6pm", "America/New_York")).toBeNull();
    expect(localDateTimeToUtc("2026-13-02T18:00", "America/New_York")).toBeNull();
  });
});

describe("formatLocal", () => {
  it("formats a short local time", () => {
    expect(formatLocal(new Date("2026-10-02T22:00:00Z"), "America/New_York")).toBe("Fri, Oct 2, 6:00 PM");
  });

  it("describes now for Claude's context", () => {
    expect(localNowLine(new Date("2026-09-29T15:00:00Z"), "America/New_York")).toBe(
      "Local time for this chat: Tue, Sep 29, 11:00 AM (America/New_York). Write times people give you as local times.",
    );
  });
});

describe("toLocalDateTime", () => {
  it("shows a UTC instant as a local date-time", () => {
    expect(toLocalDateTime(new Date("2026-10-04T00:00:00Z"), "America/New_York")).toBe("2026-10-03T20:00");
    expect(toLocalDateTime(new Date("2026-10-04T00:00:00Z"), "UTC")).toBe("2026-10-04T00:00");
  });

  it("round-trips with localDateTimeToUtc", () => {
    const local = "2027-03-14T19:30";
    expect(toLocalDateTime(localDateTimeToUtc(local, "America/Cancun")!, "America/Cancun")).toBe(local);
  });
});
