import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAuth } from "../../middleware/requireAuth.js";
import {
  config,
  devLogin,
  google,
  logout,
  logoutAll,
  refresh,
  smsRequest,
  smsVerify,
} from "./auth.controller.js";
import { requireDevLoginEnabled, requireProviderEnabled } from "./auth-providers.js";

export const authRouter = Router();

const smsRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const smsVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

authRouter.get("/config", config);

authRouter.post("/google", requireProviderEnabled("GOOGLE"), google);

authRouter.post("/sms/request", smsRequestLimiter, requireProviderEnabled("SMS"), smsRequest);
authRouter.post("/sms/verify", smsVerifyLimiter, requireProviderEnabled("SMS"), smsVerify);

authRouter.post("/refresh", refresh);
authRouter.post("/logout", requireAuth, logout);
authRouter.post("/logout-all", requireAuth, logoutAll);

// ⚠⚠⚠ TEMPORARY DEVELOPMENT AID — DELETE THIS BLOCK BEFORE PRODUCTION ⚠⚠⚠
// Passwordless sign-in as a fake user. requireDevLoginEnabled 404s it unless
// DEV_LOGIN_ENABLED is on AND NODE_ENV is not production, but the only way to be certain
// it can never be reached is for this route to not exist.
// Full removal checklist: README.md > Developer sign-in.
authRouter.post("/dev-login", requireDevLoginEnabled, devLogin);
