const MS_PER_UNIT = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
} as const;

type Unit = keyof typeof MS_PER_UNIT;

const DURATION_RE = /^(\d+)\s*(s|m|h|d|w|y)$/;

/** Parses simple durations like "15m" or "30d" (the JWT_*_EXPIRES_IN format) into milliseconds. */
export function parseDurationMs(input: string): number {
  const match = DURATION_RE.exec(input.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid duration: "${input}"`);
  }
  return Number(match[1]) * MS_PER_UNIT[match[2] as Unit];
}
