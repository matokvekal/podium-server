import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import { traceLog } from "../lib/trace-log.js";

// Express 5 recognizes this by arity (4 params), so keep all four even though `next` is unused.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  traceLog("middleware.errorHandler", {
    method: req.method,
    path: req.path,
    errName: err instanceof Error ? err.name : typeof err,
  });
  if (err instanceof ZodError) {
    const message = err.issues[0]?.message ?? "Invalid request";
    return res.status(400).json({ error: "Invalid request", message, details: err.flatten() });
  }

  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, message: err.message });
  }

  // body-parser and similar HTTP-layer errors carry status/statusCode + expose.
  // Treat those as client errors instead of collapsing everything into 500.
  if (
    typeof err === "object" &&
    err !== null &&
    (("status" in err && typeof (err as { status?: unknown }).status === "number") ||
      ("statusCode" in err && typeof (err as { statusCode?: unknown }).statusCode === "number"))
  ) {
    const status =
      ((err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode) || 500;
    const message = err instanceof Error ? err.message : "Request error";
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: "Invalid request", message });
    }
  }

  logger.error({ err, path: req.path }, "Unhandled error");
  res.status(500).json({ error: "Internal server error", message: "Internal server error" });
}
