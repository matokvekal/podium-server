import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 6-digit numeric OTP code, e.g. "042917". */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Cryptographically random opaque token (e.g. a refresh token), URL-safe. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison of two hex-encoded digests, to avoid timing side-channels. */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
