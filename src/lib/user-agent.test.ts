import { describe, expect, it } from "vitest";
import { deriveDeviceType, isBotUserAgent } from "./user-agent.js";

describe("isBotUserAgent", () => {
  it.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
    "curl/8.4.0",
    "python-requests/2.31.0",
    "Mozilla/5.0 HeadlessChrome/120.0.0.0",
    "Mozilla/5.0 (compatible; SomeUnknownSpider/1.0)",
  ])("flags a known bot UA: %s", (ua) => {
    expect(isBotUserAgent(ua)).toBe(true);
  });

  it.each([
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ])("does not flag an ordinary browser UA: %s", (ua) => {
    expect(isBotUserAgent(ua)).toBe(false);
  });

  it("treats a missing/empty UA as bot-like", () => {
    expect(isBotUserAgent("")).toBe(true);
  });
});

describe("deriveDeviceType", () => {
  it("detects mobile", () => {
    expect(
      deriveDeviceType(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      ),
    ).toBe("mobile");
    expect(deriveDeviceType("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("mobile");
  });

  it("detects tablet", () => {
    expect(deriveDeviceType("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("tablet");
  });

  it("defaults to desktop", () => {
    expect(
      deriveDeviceType("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"),
    ).toBe("desktop");
  });
});
