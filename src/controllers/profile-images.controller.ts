import type { Request, Response } from "express";
import { listProfileImages } from "../config/profile-images.js";
import { traceLog } from "../lib/trace-log.js";

/**
 * The operator-managed profile-image gallery, so the picker shows exactly what this server
 * will currently accept a selection from. Public and static — no user data in the response,
 * only filenames that already exist on disk and their resolved URLs. See
 * config/profile-images.ts for why this is a live directory scan rather than a compiled list.
 */
// GET /api/v1/profile-images
export async function listProfileImagesController(_req: Request, res: Response) {
  traceLog("profile-images.controller.listProfileImagesController");
  const data = await listProfileImages();
  res.status(200).json({ data });
}
