import { env } from "../../config/env.js";
import { MockSmsProvider } from "./mock-sms-provider.js";

export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

let cached: SmsProvider | undefined;

export function getSmsProvider(): SmsProvider {
  if (cached) return cached;

  switch (env.SMS_PROVIDER) {
    case "MOCK":
      cached = new MockSmsProvider();
      return cached;
    case "TWILIO":
      // Extension point: implement a TwilioSmsProvider class satisfying SmsProvider
      // and return it here. Not built yet — no Twilio SDK dependency until it is.
      throw new Error("SMS_PROVIDER=TWILIO is not implemented yet");
    default: {
      const exhaustive: never = env.SMS_PROVIDER;
      throw new Error(`Unknown SMS_PROVIDER: ${exhaustive}`);
    }
  }
}
