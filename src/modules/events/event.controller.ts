import type { NextFunction, Request, Response } from "express";
import type { Event, EventParticipant } from "../../db/types.js";
import { ApiError } from "../../lib/api-error.js";
import { traceLog } from "../../lib/trace-log.js";
import { selectParticipantByEventAndUser } from "./event.queries.js";
import {
  changeEventStatusSchema,
  createEventSchema,
  eventCodeParamSchema,
  eventIdParamSchema,
  joinEventSchema,
  listEventsQuerySchema,
  liveQuerySchema,
  locationBatchSchema,
  pauseEventSchema,
  publicEventsQuerySchema,
  updateEventSchema,
} from "./event.schemas.js";
import {
  cancelEvent,
  changeEventStatus,
  computeEffectiveStatus,
  createEvent,
  findActiveEventByCode,
  findParticipantForUser,
  getEventForViewer,
  getLiveRiders,
  joinEvent,
  listMyEvents,
  listPublicEvents,
  pauseEvent,
  saveLocationBatch,
  toEventConfig,
  updateEventDetails,
} from "./event.service.js";

function toEventSummary(event: Event) {
  return {
    id: event.id,
    code: event.code,
    name: event.name,
    type: event.type,
    status: event.status,
    visibility: event.visibility,
    displayMode: event.displayMode,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    location: event.location,
    ownerId: event.ownerId,
  };
}

function toEventDetail(
  event: Event,
  viewerId: number | null,
  myParticipant: EventParticipant | null = null,
) {
  return {
    ...toEventSummary(event),
    requiresBib: event.requiresBib,
    description: event.description,
    finishedAt: event.finishedAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    isOwner: event.ownerId === viewerId,
    requiresApproval: event.requiresApproval,
    isPaused: event.isPaused,
    effectiveStatus: computeEffectiveStatus(event),
    showEventInfo: event.showEventInfo,
    showParticipants: event.showParticipants,
    showRoute: event.showRoute,
    showLiveLocations: event.showLiveLocations,
    showHistoryLocations: event.showHistoryLocations,
    showResults: event.showResults,
    myParticipant: myParticipant
      ? {
          id: myParticipant.id,
          registrationStatus: myParticipant.registrationStatus,
          attendanceStatus: myParticipant.attendanceStatus,
        }
      : null,
  };
}

export async function getEventByCode(req: Request, res: Response, next: NextFunction) {
  traceLog("event.controller.getEventByCode", { code: req.params.code });
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
    traceLog("event.controller.join", { userId: req.auth!.userId, eventCode, bib });
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
    traceLog("event.controller.postLocationBatch", {
      eventId: req.params.eventId,
      participantId,
      pointCount: points.length,
    });

    const participant = await findParticipantForUser(participantId, req.auth!.userId);
    if (!participant || participant.eventId !== req.params.eventId) {
      throw new ApiError(404, "Participant not found for this event");
    }

    const saved = await saveLocationBatch(req.params.eventId, participantId, points);
    res.status(200).json({ saved });
  } catch (err) {
    next(err);
  }
}

export async function getLiveHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { riders } = liveQuerySchema.parse(req.query);
    const viewerId = req.auth?.userId ?? null;
    traceLog("event.controller.getLiveHandler", { eventId, viewerId, riders });
    const result = await getLiveRiders(eventId, viewerId, riders);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function pauseEventHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { paused } = pauseEventSchema.parse(req.body);
    traceLog("event.controller.pauseEventHandler", { eventId, userId: req.auth!.userId, paused });
    const event = await pauseEvent(eventId, req.auth!.userId, paused);
    res.status(200).json({ data: toEventDetail(event, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}

export async function createEventHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createEventSchema.parse(req.body);
    traceLog("event.controller.createEventHandler", {
      userId: req.auth!.userId,
      name: input.name,
    });
    const event = await createEvent(req.auth!.userId, input);
    res.status(201).json({ data: toEventDetail(event, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}

export async function listEventsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { filter } = listEventsQuerySchema.parse(req.query);
    traceLog("event.controller.listEventsHandler", { userId: req.auth!.userId, filter });
    const events = await listMyEvents(req.auth!.userId, filter);
    res.status(200).json({ data: events.map(toEventSummary) });
  } catch (err) {
    next(err);
  }
}

export async function listPublicEventsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { limit, offset } = publicEventsQuerySchema.parse(req.query);
    traceLog("event.controller.listPublicEventsHandler", { limit, offset });
    const events = await listPublicEvents(limit, offset);
    res.status(200).json({ data: events.map(toEventSummary) });
  } catch (err) {
    next(err);
  }
}

export async function getEventHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("event.controller.getEventHandler", { eventId, viewerId });
    const event = await getEventForViewer(eventId, viewerId);
    const myParticipant =
      viewerId !== null ? await selectParticipantByEventAndUser(eventId, viewerId) : null;
    res.status(200).json({ data: toEventDetail(event, viewerId, myParticipant) });
  } catch (err) {
    next(err);
  }
}

export async function updateEventHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const input = updateEventSchema.parse(req.body);
    traceLog("event.controller.updateEventHandler", { eventId, userId: req.auth!.userId });
    const event = await updateEventDetails(eventId, req.auth!.userId, input);
    res.status(200).json({ data: toEventDetail(event, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}

export async function changeEventStatusHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { status } = changeEventStatusSchema.parse(req.body);
    traceLog("event.controller.changeEventStatusHandler", {
      eventId,
      userId: req.auth!.userId,
      status,
    });
    const event = await changeEventStatus(eventId, req.auth!.userId, status);
    res.status(200).json({ data: toEventDetail(event, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}

export async function cancelEventHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    traceLog("event.controller.cancelEventHandler", { eventId, userId: req.auth!.userId });
    const event = await cancelEvent(eventId, req.auth!.userId);
    res.status(200).json({ data: toEventDetail(event, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
}
