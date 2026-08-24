import { randomUUID } from "node:crypto";
import path from "node:path";
import cors from "cors";
import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { UPLOAD_MIME_TYPES, USER_IMAGE_RULES } from "./config/user-images.js";
import { logger } from "./lib/logger.js";
import { UPLOADS_URL_PREFIX } from "./lib/user-image-storage.js";
import { PRESET_URL_PREFIX } from "./lib/user-images.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { authRouter } from "./routes/auth.routes.js";
import { eventRouter } from "./routes/event.routes.js";
import { routeLibraryRouter } from "./routes/routeLibrary.routes.js";
import { teamRouter } from "./routes/team.routes.js";
import { userRouter } from "./routes/user.routes.js";

export function createApp(): Express {
  const app = express();

  // Trust exactly one hop (the nginx reverse proxy in front of the app) so
  // express-rate-limit can trust X-Forwarded-For without allowing clients to spoof it.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.headers["x-request-id"]?.toString() ?? randomUUID(),
    }),
  );

  app.use((req, res, next) => {
    res.setHeader("x-request-id", String(req.id));
    next();
  });

  app.use(
    cors({
      origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // X-Client-Action-Id is not optional here. The client attaches it to EVERY mutation
      // (apiMutate in podium-client/src/lib/api-client.ts), and a header the preflight does
      // not allow makes the browser block the request before it is sent — so reads worked
      // while every write failed as "Could not reach the server", which reads like the API
      // is down rather than like a CORS rejection. See middleware/clientActions.ts.
      allowedHeaders: ["Content-Type", "Authorization", "X-Client-Action-Id"],
      // The request id is on every response; exposing it lets the browser console show the
      // same id the server logged, which is what makes a report traceable.
      exposedHeaders: ["x-request-id"],
    }),
  );

  /**
   * Route geometry is the one genuinely large body this API takes: a GPX of a 100 km ride is
   * tens of thousands of points, which is megabytes as JSON — 100 kb would 413 every real
   * upload. Mounted BEFORE the global parser and scoped to route-upload paths; body-parser
   * no-ops on an already-parsed request, so everything else still gets the tight limit.
   */

  app.use((req, _res, next) => {
    console.log(">>> INCOMING", req.method, req.url);
    next();
  });
  app.use("/api/v1/routes", express.json({ limit: "15mb" }));
  app.use("/api/v1/events/:eventId/route", express.json({ limit: "15mb" }));

  /**
   * Avatar/cover uploads arrive as raw image bytes, not multipart and not base64 — so there
   * is no filename anywhere in the request to sanitise, and the body IS the file.
   *
   * Scoped and mounted before the global JSON parser for the same reason the route-geometry
   * limits above are. `type` restricts buffering to the four image content types, so the
   * OTHER shape these same paths accept — JSON { presetId } — falls straight through to
   * express.json below and arrives as an object. The controller tells them apart by asking
   * whether req.body is a Buffer.
   *
   * `limit` is the transport guard: an oversized upload is refused here without being read
   * into memory. It is not the only guard — inspectImage() checks the same ceiling against
   * the buffer, because the limit belongs to the rule, not to the HTTP layer.
   */
  app.use(
    "/api/v1/users/me/avatar",
    express.raw({ type: UPLOAD_MIME_TYPES, limit: USER_IMAGE_RULES.avatar.maxBytes }),
  );
  app.use(
    "/api/v1/users/me/cover",
    express.raw({ type: UPLOAD_MIME_TYPES, limit: USER_IMAGE_RULES.cover.maxBytes }),
  );

  app.use(express.json({ limit: "100kb" }));

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  /**
   * User images: the shipped preset art, and riders' uploads.
   *
   * In production nginx serves both directly from disk (see TODO-install-server.md) and
   * these mounts are never reached — they are what makes the feature work in development
   * and what keeps the app self-contained if nginx is not configured for it yet.
   *
   * helmet() sets Cross-Origin-Resource-Policy: same-origin by default, which would block
   * the web client (app.domain.com) from loading any image from the API (api.domain.com).
   * Relaxing it HERE and only here keeps that default in force for every JSON route: these
   * two paths serve nothing but public, immutable picture files.
   */
  const imageStatic: Parameters<typeof express.static>[1] = {
    index: false,
    dotfiles: "deny",
    redirect: false,
    // Every uploaded file carries a random token in its name and preset ids are stable, so
    // a URL's contents never change — a replacement is always a different URL.
    immutable: true,
    maxAge: "1y",
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  };

  app.use(PRESET_URL_PREFIX, express.static(path.join(env.ASSETS_DIR, "presets"), imageStatic));
  app.use(UPLOADS_URL_PREFIX, express.static(env.UPLOADS_DIR, imageStatic));

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/users", userRouter);
  app.use("/api/v1/events", eventRouter);
  app.use("/api/v1/routes", routeLibraryRouter);
  app.use("/api/v1/teams", teamRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
