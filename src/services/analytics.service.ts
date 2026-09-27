// Records one PAGE_VIEW analytics event. Thin on purpose: derive the server-side dimensions
// (isBot, deviceType, the authenticated user id) and hand off to trackAuditEvent, which is
// already non-fatal by construction — a DB hiccup here must never surface to the caller.

import { trackAuditEvent } from "../db/audit/audit.service.js";
import type { PageViewInput } from "../schemas/analytics.schemas.js";
import { deriveDeviceType, isBotUserAgent } from "../lib/user-agent.js";

export interface PageViewContext {
  userId: number | null;
  userAgent: string;
}

export async function recordPageView(input: PageViewInput, context: PageViewContext): Promise<void> {
  const isBot = isBotUserAgent(context.userAgent);
  const deviceType = deriveDeviceType(context.userAgent);

  await trackAuditEvent({
    type: "PAGE_VIEW",
    userId: context.userId,
    details: {
      path: input.path,
      visitorId: input.visitorId,
      sessionId: input.sessionId,
      referrer: input.referrer ?? null,
      isBot,
      deviceType,
    },
  });
}
