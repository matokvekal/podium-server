import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { eventRouter } from "./modules/events/event.routes.js";
import { routeRouter } from "./modules/routes/route.routes.js";
import { teamRouter } from "./modules/teams/team.routes.js";
import { userRouter } from "./modules/users/user.routes.js";

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
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );

  /**
   * Route geometry is the one genuinely large body this API takes: a GPX of a 100 km ride is
   * tens of thousands of points, which is megabytes as JSON — 100 kb would 413 every real
   * upload. Mounted BEFORE the global parser and scoped to route-upload paths; body-parser
   * no-ops on an already-parsed request, so everything else still gets the tight limit.
   */
  app.use("/api/v1/routes", express.json({ limit: "15mb" }));
  app.use("/api/v1/events/:eventId/route", express.json({ limit: "15mb" }));
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

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/users", userRouter);
  app.use("/api/v1/events", eventRouter);
  app.use("/api/v1/routes", routeRouter);
  app.use("/api/v1/teams", teamRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
