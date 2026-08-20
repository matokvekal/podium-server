import type { NextFunction, Request, Response } from "express";
import type { ParticipantTrack } from "../../db/types.js";
import { traceLog } from "../../lib/trace-log.js";
import { eventIdParamSchema } from "../events/event.schemas.js";
import { participantIdParamSchema } from "../participants/participants.schemas.js";
import { toRouteSummary } from "../routes/route.controller.js";
import { getEventResults, getEventTracks, getParticipantTrack } from "./results.service.js";

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

export async function getResultsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("results.controller.getResultsHandler", { eventId, viewerId });
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

export async function getTracksHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("results.controller.getTracksHandler", { eventId, viewerId });
    const tracks = await getEventTracks(eventId, viewerId);
    res.status(200).json({ data: tracks.map(toTrack) });
  } catch (err) {
    next(err);
  }
}

export async function getParticipantTrackHandler(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("results.controller.getParticipantTrackHandler", {
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
