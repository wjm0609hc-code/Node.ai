import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../types";
import { attachContactCards } from "./vcards";

const base: InboundMessage = {
  type: "message",
  provider: "sendblue",
  messageId: "m1",
  groupId: null,
  from: "+15550200001",
  text: "",
  mediaUrls: [],
  service: "imessage",
  mentions: [],
  sentAt: new Date(),
};

const VCF = "BEGIN:VCARD\nFN:Jake Miller\nTEL:+1 555 020 0002\nEND:VCARD";

describe("attachContactCards", () => {
  it("fetches .vcf attachments, parses them, and removes them from media", async () => {
    const fetchText = vi.fn(async () => VCF);
    const event = { ...base, mediaUrls: ["https://cdn.sendblue.test/a/jake.vcf", "https://cdn.sendblue.test/a/photo.jpg"] };
    expect(await attachContactCards(event, fetchText)).toEqual({
      ...event,
      mediaUrls: ["https://cdn.sendblue.test/a/photo.jpg"],
      contactCards: [{ name: "Jake Miller", phone: "+15550200002" }],
    });
    expect(fetchText).toHaveBeenCalledWith("https://cdn.sendblue.test/a/jake.vcf");
  });

  it("leaves events without vCards alone", async () => {
    const fetchText = vi.fn(async () => VCF);
    const event = { ...base, mediaUrls: ["https://cdn.sendblue.test/a/photo.jpg"] };
    expect(await attachContactCards(event, fetchText)).toBe(event);
    expect(fetchText).not.toHaveBeenCalled();
  });

  it("keeps the attachment as media if it can't be read", async () => {
    const event = { ...base, mediaUrls: ["https://cdn.sendblue.test/a/x.vcf?sig=1"] };
    const out = await attachContactCards(event, async () => {
      throw new Error("403");
    });
    expect(out.mediaUrls).toEqual(event.mediaUrls);
    expect(out.contactCards).toBeUndefined();
  });
});
