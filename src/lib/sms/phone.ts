const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Strips common formatting and validates E.164 shape. Returns null if invalid. */
export function normalizePhoneE164(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s\-().]/g, "");
  return E164_PATTERN.test(cleaned) ? cleaned : null;
}
