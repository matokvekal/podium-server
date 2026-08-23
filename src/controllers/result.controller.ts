import type { NextFunction, Request, Response } from "express";
import type { ParticipantTrack } from "../db/types.js";
import { traceLog } from "../lib/trace-log.js";
import { eventIdParamSchema } from "../schemas/event.schemas.js";
import { participantIdParamSchema } from "../schemas/participant.schemas.js";
import { toRouteSummary } from "./routeLibrary.controller.js";
import { getEventResults, getEventTracks, getParticipantTrack } from "../services/result.service.js";

function toTrack(track: ParticipantTrack) {
  return {
    participantId: track.participantId,
    points: track.points,
    pointCount: track.pointCount,
    distanceKm: track.distanceKm,
    startedAt: track.startedAt,
    endedAt: track.endedAt,
    hadEmergency: track.hadEmergency,
  };
}

// GET /api/v1/events/:eventId/results
export async function getResultsController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("results.controller.getResultsController", { eventId, viewerId });
    const results = await getEventResults(eventId, viewerId);
    res.status(200).json({
      data: {
        organizer: results.organizer,
        // Same route shape as everywhere else in this API — preview geometry, full line from
        // GET /routes/:routeId. One shape for "a route", not a second one just for results.
        route: results.route ? toRouteSummary(results.route) : null,
        riders: results.riders,
      },
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/events/:eventId/tracks
export async function getTracksController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("results.controller.getTracksController", { eventId, viewerId });
    const tracks = await getEventTracks(eventId, viewerId);
    res.status(200).json({ data: tracks.map(toTrack) });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/events/:eventId/tracks/:participantId
export async function getParticipantTrackController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("results.controller.getParticipantTrackController", {
      eventId,
      participantId,
      viewerId,
    });
    const track = await getParticipantTrack(eventId, participantId, viewerId);
    res.status(200).json({ data: toTrack(track) });
  } catch (err) {
    next(err);
  }
}
