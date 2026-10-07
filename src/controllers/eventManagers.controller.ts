// Controllers for RIDE MANAGERS — /api/v1/events/:eventId/managers, /manager-invites.
// Thin: parse, hand to eventManagers.service.ts (which does the authorization), serialise.

import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import { eventIdParamSchema } from "../schemas/event.schemas.js";
import {
  addEventManagerSchema,
  eventManagerInviteParamSchema,
  eventManagerParamSchema,
} from "../schemas/eventManagers.schemas.js";
import {
  addEventManager,
  listEventManagers,
  removeEventManager,
  removeManagerInvite,
} from "../services/eventManagers.service.js";

// GET /api/v1/events/:eventId/managers
export async function listEventManagersController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    traceLog("eventManagers.controller.listEventManagersController", { eventId });
    const view = await listEventManagers(eventId, req.auth!.userId);
    res.status(200).json({ data: view });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/managers   { email }
export async function addEventManagerController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { email } = addEventManagerSchema.parse(req.body);
    traceLog("eventManagers.controller.addEventManagerController", { eventId });
    const result = await addEventManager(eventId, req.auth!.userId, email);
    res.status(result.status === "added" ? 201 : 202).json({ data: result });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/events/:eventId/managers/:userId
export async function removeEventManagerController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { eventId, userId } = eventManagerParamSchema.parse(req.params);
    traceLog("eventManagers.controller.removeEventManagerController", { eventId, userId });
    await removeEventManager(eventId, req.auth!.userId, userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/events/:eventId/manager-invites/:email
export async function removeManagerInviteController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { eventId, email } = eventManagerInviteParamSchema.parse(req.params);
    traceLog("eventManagers.controller.removeManagerInviteController", { eventId });
    await removeManagerInvite(eventId, req.auth!.userId, email);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
