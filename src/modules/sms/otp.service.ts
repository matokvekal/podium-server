import { ApiError } from "../../lib/api-error.js";
import { generateOtpCode, sha256Hex } from "../../lib/crypto.js";
import { logger } from "../../lib/logger.js";
import {
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_REQUESTS_PER_HOUR,
  OTP_RESEND_COOLDOWN_SECONDS,
} from "./otp.constants.js";
import {
  consumeChallenge,
  countChallengesSince,
  findChallengeById,
  findLatestChallengeSince,
  incrementChallengeAttempts,
  insertChallenge,
  setChallengeCodeHash,
} from "./otp.queries.js";
import { normalizePhoneE164 } from "./phone.js";
import { getSmsProvider } from "./sms-provider.js";

function hashOtp(challengeId: number, code: string): string {
  return sha256Hex(`${challengeId}:${code}`);
}

export async function requestOtp(
  rawPhone: string,
  requestIp: string | null,
): Promise<{ challengeId: number }> {
  const phone = normalizePhoneE164(rawPhone);
  if (!phone) {
    throw new ApiError(400, "Phone number must be in E.164 format, e.g. +15551234567");
  }

  const now = new Date();

  const requestsInLastHour = await countChallengesSince(
    phone,
    new Date(now.getTime() - 60 * 60 * 1000),
  );
  if (requestsInLastHour >= OTP_MAX_REQUESTS_PER_HOUR) {
    logger.warn({ phone }, "requestOtp: hourly request limit exceeded");
    throw new ApiError(429, "Too many OTP requests for this phone number — try again later");
  }

  const recentChallenge = await findLatestChallengeSince(
    phone,
    new Date(now.getTime() - OTP_RESEND_COOLDOWN_SECONDS * 1000),
  );
  if (recentChallenge) {
    logger.warn({ phone }, "requestOtp: resend cooldown still active");
    throw new ApiError(429, "Please wait before requesting another code");
  }

  const code = generateOtpCode();

  // codeHash embeds the row's own id as a per-challenge salt, so the id has to come from the
  // DB (identity column) before the hash can be computed — hence insert, then hash, then update.
  const challenge = await insertChallenge({
    phone,
    expiresAt: new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000),
    maxAttempts: OTP_MAX_ATTEMPTS,
    requestIp,
  });
  await setChallengeCodeHash(challenge.id, hashOtp(challenge.id, code));

  await getSmsProvider().sendOtp(phone, code);
  logger.info({ phone, challengeId: challenge.id }, "otp challenge created and sent");

  return { challengeId: challenge.id };
}

/** Returns the verified, normalized phone number on success. */
export async function verifyOtp(challengeId: number, code: string): Promise<string> {
  const challenge = await findChallengeById(challengeId);
  if (!challenge) {
    logger.warn({ challengeId }, "verifyOtp: challenge not found");
    throw new ApiError(404, "OTP challenge not found");
  }
  if (challenge.consumedAt) {
    logger.warn({ challengeId }, "verifyOtp: challenge already consumed");
    throw new ApiError(400, "This code has already been used");
  }
  if (challenge.expiresAt < new Date()) {
    logger.warn({ challengeId }, "verifyOtp: challenge expired");
    throw new ApiError(400, "This code has expired");
  }
  if (challenge.attemptCount >= challenge.maxAttempts) {
    logger.warn({ challengeId }, "verifyOtp: max attempts exceeded");
    throw new ApiError(429, "Too many incorrect attempts for this code");
  }

  await incrementChallengeAttempts(challengeId);

  if (hashOtp(challengeId, code) !== challenge.codeHash) {
    logger.warn({ challengeId, attempt: challenge.attemptCount + 1 }, "verifyOtp: incorrect code");
    throw new ApiError(401, "Incorrect code");
  }

  await consumeChallenge(challengeId, new Date());
  logger.info({ challengeId, phone: challenge.phone }, "otp verified");

  return challenge.phone;
}
