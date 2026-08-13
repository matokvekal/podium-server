import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import type { SmsProvider } from "./sms-provider.js";

/** Development/test provider — never contacts a real SMS network. */
export class MockSmsProvider implements SmsProvider {
  async sendOtp(phone: string, code: string): Promise<void> {
    if (env.NODE_ENV === "production") {
      // MockSmsProvider should not be selected in production, but even so: never log the code.
      logger.warn({ phone }, "MockSmsProvider used in production — no real SMS was sent");
      return;
    }
    logger.debug({ phone, otpCode: code }, "MockSmsProvider: OTP code (dev/test only)");
  }
}
