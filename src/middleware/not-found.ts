import type { Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";

export function notFound(req: Request, res: Response) {
  traceLog("middleware.notFound", { method: req.method, path: req.path });
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
}
