// Controllers for RIDE STOP POINTS — /api/v1/events/:eventId/stops[/:stopId] (sql/049).
// Thin: parse, hand to rideStops.service.ts (which does the authorization), serialise.

import type { NextFunction, Request, Response } from "express";
import { traceLog } from "../lib/trace-log.js";
import { eventIdParamSchema } from "../schemas/event.schemas.js";
import {
  rideStopCreateSchema,
  rideStopParamSchema,
  rideStopUpdateSchema,
} from "../schemas/rideStops.schemas.js";
import {
  addRideStop,
  editRideStop,
  listRideStops,
  removeRideStop,
} from "../services/rideStops.service.js";

// GET /api/v1/events/:eventId/stops
export async function listRideStopsController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("rideStops.controller.listRideStopsController", { eventId, viewerId });
    const view = await listRideStops(eventId, viewerId);
    res.status(200).json({ data: view });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/stops   { label, lat, lng, kind? }
export async function createRideStopController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const input = rideStopCreateSchema.parse(req.body);
    traceLog("rideStops.controller.createRideStopController", { eventId });
    const stop = await addRideStop(eventId, req.auth!.userId, input);
    res.status(201).json({ data: stop });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/events/:eventId/stops/:stopId   { label?, lat?, lng?, kind?, sortOrder? }
export async function updateRideStopController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, stopId } = rideStopParamSchema.parse(req.params);
    const patch = rideStopUpdateSchema.parse(req.body);
    traceLog("rideStops.controller.updateRideStopController", { eventId, stopId });
    const stop = await editRideStop(eventId, stopId, req.auth!.userId, patch);
    res.status(200).json({ data: stop });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/events/:eventId/stops/:stopId
export async function deleteRideStopController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, stopId } = rideStopParamSchema.parse(req.params);
    traceLog("rideStops.controller.deleteRideStopController", { eventId, stopId });
    await removeRideStop(eventId, stopId, req.auth!.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
