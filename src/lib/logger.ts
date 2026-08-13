import pino from "pino";
import { env } from "../config/env.js";

// Bearer tokens (Commissaire access/refresh, Google ID tokens) are never surfaced in structured
// logs, regardless of how they get attached to a log call. OTP codes are the one intentional
// exception outside production: MockSmsProvider logs the code so local/dev testing can read it
// (see SETUP.md) — that path is redacted too once NODE_ENV is "production".
const tokenRedactPaths = [
  "req.headers.authorization",
  "*.authorization",
  "*.idToken",
  "*.accessToken",
  "*.refreshToken",
];

// Every log line goes to both stdout (so `pm2 logs` shows it live) and logs/app.log (so history
// survives a pm2 log rotation/restart). Path is relative to the process cwd, which pm2 sets to
// the app directory by default.
export const logger = pino(
  {
    level: env.LOG_LEVEL,
    redact: {
      paths: env.NODE_ENV === "production" ? [...tokenRedactPaths, "*.otpCode"] : tokenRedactPaths,
      censor: "[redacted]",
    },
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: pino.destination({ dest: "logs/app.log", mkdir: true, sync: false }) },
  ]),
);
