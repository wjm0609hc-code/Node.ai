import { describe, expect, it } from "vitest";
import { appConfig } from "./config";

describe("appConfig", () => {
  it("normalizes the app URL (lowercase host, no trailing slash), so links Nod sends look right", () => {
    expect(appConfig({ NOD_APP_URL: " HTTPS://NODE-AI-ROSY.VERCEL.APP/ " } as NodeJS.ProcessEnv).appUrl).toBe("https://node-ai-rosy.vercel.app");
    expect(appConfig({ NOD_APP_URL: "https://nod.example.com" } as NodeJS.ProcessEnv).appUrl).toBe("https://nod.example.com");
    expect(appConfig({} as NodeJS.ProcessEnv).appUrl).toBe("");
  });
});
