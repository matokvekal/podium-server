// Routes for AUTH — mounted by app.ts at "/api/v1/auth".

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  authConfigController,
  googleAuthController,
  logoutAllController,
  logoutController,
  refreshController,
  smsRequestController,
  smsVerifyController,
} from "../controllers/auth.controller.js";
import { requireProviderEnabled } from "../config/auth-providers.js";
import { requireAuth } from "../middleware/requireAuth.js";

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

// GET /api/v1/auth/config
authRouter.get("/config", authConfigController);

// POST /api/v1/auth/google
authRouter.post("/google", requireProviderEnabled("GOOGLE"), googleAuthController);

// POST /api/v1/auth/sms/request
authRouter.post(
  "/sms/request",
  smsRequestLimiter,
  requireProviderEnabled("SMS"),
  smsRequestController,
);

// POST /api/v1/auth/sms/verify
authRouter.post("/sms/verify", smsVerifyLimiter, requireProviderEnabled("SMS"), smsVerifyController);

// POST /api/v1/auth/refresh
authRouter.post("/refresh", refreshController);

// POST /api/v1/auth/logout
authRouter.post("/logout", requireAuth, logoutController);

// POST /api/v1/auth/logout-all
authRouter.post("/logout-all", requireAuth, logoutAllController);
