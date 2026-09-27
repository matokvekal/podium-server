// Heuristic-only User-Agent classification for PAGE_VIEW analytics (see
// src/controllers/analytics.controller.ts). This is a best-effort signal, not a security
// control: a bot that spoofs a normal browser UA reads as human, and that is expected —
// the goal is a rough "traffic vs. crawlers" split for /admin2026, nothing more.

const BOT_UA_PATTERNS: RegExp[] = [
  /googlebot/i,
  /bingbot/i,
  /ahrefsbot/i,
  /semrushbot/i,
  /yandexbot/i,
  /duckduckbot/i,
  /baiduspider/i,
  /facebookexternalhit/i,
  /curl\//i,
  /python-requests/i,
  /go-http-client/i,
  /headlesschrome/i,
  /phantomjs/i,
  /puppeteer/i,
  /playwright/i,
  /\bbot\b/i,
  /spider/i,
  /crawler/i,
];

/** No UA at all is not something a real browser ever sends — treat it as bot-like too. */
export function isBotUserAgent(userAgent: string): boolean {
  if (!userAgent) return true;
  return BOT_UA_PATTERNS.some((pattern) => pattern.test(userAgent));
}

export type DeviceType = "mobile" | "tablet" | "desktop";

/** Rough device bucket for the traffic breakdown — not exhaustive, just mobile/tablet/desktop. */
export function deriveDeviceType(userAgent: string): DeviceType {
  if (/ipad|tablet/i.test(userAgent)) return "tablet";
  if (/mobi|android|iphone/i.test(userAgent)) return "mobile";
  return "desktop";
}
