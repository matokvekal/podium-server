import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../../lib/api-error.js";
import { eventCodeParamSchema, joinEventSchema, locationBatchSchema } from "./event.schemas.js";
import {
  findActiveEventByCode,
  findParticipantForUser,
  joinEvent,
  saveLocationBatch,
  toEventConfig,
} from "./event.service.js";

export async function getEventByCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = eventCodeParamSchema.parse(req.params);
    const event = await findActiveEventByCode(code);
    if (!event) {
      throw new ApiError(404, "Event not found");
    }
    res.status(200).json(toEventConfig(event));
  } catch (err) {
    next(err);
  }
}

export async function join(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventCode, bib } = joinEventSchema.parse(req.body);
    const { event, participant } = await joinEvent(req.auth!.userId, eventCode, bib);
    res.status(200).json({
      eventId: event.id,
      participantId: participant.id,
      eventName: event.name,
      eventType: event.type,
      requiresBib: event.requiresBib,
    });
  } catch (err) {
    next(err);
  }
}

export async function postLocationBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const { participantId, points } = locationBatchSchema.parse(req.body);

    const participant = await findParticipantForUser(participantId, req.auth!.userId);
    if (!participant || participant.eventId !== req.params.eventId) {
      throw new ApiError(404, "Participant not found for this event");
    }

    const saved = await saveLocationBatch(participantId, points);
    res.status(200).json({ saved });
  } catch (err) {
    next(err);
  }
}
