import { z } from "zod";

try {
  process.loadEnvFile();
} catch {
  // No .env file present — fine in production/CI, where real env vars are set directly.
}

const csv = () =>
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );

/** An on/off env var. Unset means `defaultValue`; "true"/"1"/"yes" (any case) mean on. */
const boolFlag = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === "") return defaultValue;
      return ["true", "1", "yes"].includes(value.trim().toLowerCase());
    });

export const AUTH_PROVIDER_VALUES = ["GOOGLE", "SMS", "EMAIL"] as const;
export type AuthProvider = (typeof AUTH_PROVIDER_VALUES)[number];

const authProviders = () =>
  z
    .string()
    .optional()
    .default("GOOGLE")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(AUTH_PROVIDER_VALUES)));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  DATABASE_URL: z.string().optional(),

  GOOGLE_CLIENT_IDS: csv(),
  CORS_ORIGINS: csv(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  JWT_ACCESS_SECRET: z.string().optional(),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  // Refresh tokens are opaque random values (see lib/crypto.ts), not JWTs, so this only
  // controls session lifetime — there is no JWT_REFRESH_SECRET to sign/verify.
  JWT_REFRESH_EXPIRES_IN: z.string().default("30d"),

  SMS_PROVIDER: z.enum(["MOCK", "TWILIO"]).default("MOCK"),
  AUTH_PROVIDERS: authProviders(),

  // Raw GPS retention. Only location_points are ever deleted, and never for an event whose
  // participant_tracks have not been written — losing a track is the one thing the design
  // exists to prevent.
  LOCATION_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // Flat free-tier cap on how many events one owner can have live at once — replaces the old
  // DB-level "exactly 1" unique index (see sql/010-drop-one-live-per-owner.sql). Enforced in
  // src/modules/events/entitlements.ts, which is the seam for per-plan limits later.
  MAX_CONCURRENT_LIVE_EVENTS_FREE: z.coerce.number().int().positive().default(2),

  // Toggleable console.log call-tracing through controllers/middleware — see lib/trace-log.ts.
  // On by default so it's visible without any setup; set to "false" to go quiet.
  CONSOLE_TRACE: boolFlag(true),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

const data = parsed.data;
const MIN_SECRET_LENGTH = 32;

function resolveSecret(
  value: string | undefined,
  envVarName: string,
  devFallback: string,
  nodeEnv: (typeof data)["NODE_ENV"],
): string {
  if (value && value.length >= MIN_SECRET_LENGTH) return value;

  if (nodeEnv === "production") {
    console.error(`${envVarName} is required in production and must be at least 32 characters`);
    process.exit(1);
  }

  if (value) {
    console.warn(
      `${envVarName} is shorter than 32 characters — using it anyway in ${nodeEnv}, ` +
        "but this would be rejected in production.",
    );
    return value;
  }

  console.warn(`${envVarName} is not set — using an insecure development-only default.`);
  return devFallback;
}

export const env = {
  ...data,
  JWT_ACCESS_SECRET: resolveSecret(
    data.JWT_ACCESS_SECRET,
    "JWT_ACCESS_SECRET",
    "dev-only-access-secret-do-not-use-in-production-0001",
    data.NODE_ENV,
  ),
};

if (env.GOOGLE_CLIENT_IDS.length === 0) {
  console.warn("GOOGLE_CLIENT_IDS is not set — Google sign-in will reject every request.");
}
