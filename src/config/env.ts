import path from "node:path";
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
  DEV_LOGIN_ENABLED: boolFlag(false),

  // Raw GPS retention. Only location_points are ever deleted, and never for an event whose
  // participant_tracks have not been written — losing a track is the one thing the design
  // exists to prevent.
  LOCATION_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // Flat free-tier cap on how many events one owner can have live at once.
  //
  // NOT CURRENTLY ENFORCED. It was read only by src/modules/events/entitlements.ts, which
  // nothing ever imported; that file has been deleted. The limit actually applied today is
  // "one live event per owner", enforced in event.service.ts via selectLiveEventForOwner —
  // so changing this number has no effect. Kept because it is a documented deployment knob,
  // and because it is what a real per-plan limit should read (see authz/plans.ts).
  MAX_CONCURRENT_LIVE_EVENTS_FREE: z.coerce.number().int().positive().default(2),

  // ── Default limits for a NEW user ────────────────────────────────────────────────────────
  //
  // These are a TEMPLATE, not a runtime fallback. They are read exactly once per user, when
  // their user_limits row is created (at signup, or by the sql/019 backfill). After that the
  // row is the only thing authorization reads, so changing a number here does NOT move any
  // existing user — that is a deliberate UPDATE against user_limits.
  DEFAULT_EVENTS_PER_WEEK: z.coerce.number().int().nonnegative().default(3),
  DEFAULT_PARTICIPANTS_PER_EVENT: z.coerce.number().int().nonnegative().default(50),
  DEFAULT_GROUPS_PER_EVENT: z.coerce.number().int().nonnegative().default(2),
  DEFAULT_TEAMS_OWNED: z.coerce.number().int().nonnegative().default(2),

  // Toggleable console.log call-tracing through controllers/middleware — see lib/trace-log.ts.
  // On by default so it's visible without any setup; set to "false" to go quiet.
  CONSOLE_TRACE: boolFlag(true),

  // Where a rider's uploaded avatar/cover bytes live. This MUST be outside the directory a
  // deployment replaces: git checkout, npm build, pm2 restart and the GitHub Actions deploy
  // all rewrite /var/www/podium, and an upload root underneath it would be erased by a
  // routine release. Production is /var/lib/podium/uploads and is required there — see
  // resolveUploadsDir() below, which refuses to start rather than fall back to a path a
  // deploy can reach. The dev default is repo-local and gitignored.
  UPLOADS_DIR: z.string().optional(),

  // Absolute origin this API is reachable at, used to build image URLs. It has to be
  // absolute: the web client is served from a different host (app.domain.com) than the API
  // (api.domain.com), so a relative "/uploads/..." would resolve against the wrong origin.
  PUBLIC_BASE_URL: z.string().optional(),

  // Preset art (assets/presets/), which ships WITH the code and is read-only at runtime.
  // Unlike UPLOADS_DIR this is meant to be replaced by every deploy.
  ASSETS_DIR: z.string().optional(),
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

/**
 * The upload root. Unset is fine in development — a repo-local, gitignored directory. In
 * production it is required and must be absolute: the whole point of the setting is that a
 * deployment cannot reach it, and a relative default would sit inside the code tree that
 * every release replaces.
 */
function resolveUploadsDir(value: string | undefined, nodeEnv: (typeof data)["NODE_ENV"]): string {
  if (value && value.trim() !== "") return path.resolve(value.trim());

  if (nodeEnv === "production") {
    console.error(
      "UPLOADS_DIR is required in production and must point OUTSIDE the deployment " +
        "directory (e.g. /var/lib/podium/uploads). Uploads written inside the app directory " +
        "are destroyed by the next deploy.",
    );
    process.exit(1);
  }

  return path.resolve(process.cwd(), "var/uploads");
}

export const env = {
  ...data,
  JWT_ACCESS_SECRET: resolveSecret(
    data.JWT_ACCESS_SECRET,
    "JWT_ACCESS_SECRET",
    "dev-only-access-secret-do-not-use-in-production-0001",
    data.NODE_ENV,
  ),
  UPLOADS_DIR: resolveUploadsDir(data.UPLOADS_DIR, data.NODE_ENV),
  ASSETS_DIR: path.resolve(
    data.ASSETS_DIR && data.ASSETS_DIR.trim() !== ""
      ? data.ASSETS_DIR.trim()
      : path.join(process.cwd(), "assets"),
  ),
  /** No trailing slash, so callers can always concatenate a leading-slash path. */
  PUBLIC_BASE_URL: (data.PUBLIC_BASE_URL?.trim() || `http://localhost:${data.PORT}`).replace(
    /\/+$/,
    "",
  ),
};

if (env.GOOGLE_CLIENT_IDS.length === 0) {
  console.warn("GOOGLE_CLIENT_IDS is not set — Google sign-in will reject every request.");
}
