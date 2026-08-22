import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAuth } from "../../middleware/requireAuth.js";
import {
  config,
  google,
  logout,
  logoutAll,
  refresh,
  smsRequest,
  smsVerify,
} from "./auth.controller.js";
import { requireProviderEnabled } from "./auth-providers.js";

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
