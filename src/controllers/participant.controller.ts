import type { NextFunction, Request, Response } from "express";
import type { EventParticipant } from "../db/types.js";
import { traceLog } from "../lib/trace-log.js";
import {
  addParticipantSchema,
  bulkAddParticipantsSchema,
  participantIdParamSchema,
  participantsEventIdParamSchema,
  setAttendanceSchema,
  setResultSchema,
  updateParticipantSchema,
} from "../schemas/participant.schemas.js";
import {
  addParticipant,
  addParticipants,
  approveParticipant,
  editParticipant,
  listParticipantsForViewer,
  rejectParticipant,
  removeParticipant,
  setAttendance,
  setResult,
} from "../services/participant.service.js";

function toParticipantSummary(participant: EventParticipant) {
  return {
    id: participant.id,
    eventId: participant.eventId,
    userId: participant.userId,
    name: participant.name,
    avatarUrl: participant.avatarUrl,
    bib: participant.bib,
    email: participant.email,
    phone: participant.phone,
    category: participant.category,
    team: participant.team,
    countryCode: participant.countryCode,
    groupId: participant.groupId,
    registrationStatus: participant.registrationStatus,
    attendanceStatus: participant.attendanceStatus,
    resultStatus: participant.resultStatus,
    joinedAt: participant.joinedAt,
    finishedAt: participant.finishedAt,
    finishPosition: participant.finishPosition,
  };
}

// GET /api/v1/events/:eventId/participants
export async function listParticipantsController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = participantsEventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("participants.controller.listParticipantsController", { eventId, viewerId });
    const participants = await listParticipantsForViewer(eventId, viewerId);
    res.status(200).json({ data: participants.map(toParticipantSummary) });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/participants
export async function addParticipantController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = participantsEventIdParamSchema.parse(req.params);
    const input = addParticipantSchema.parse(req.body);
    traceLog("participants.controller.addParticipantController", {
      eventId,
      userId: req.auth!.userId,
      name: input.name,
    });
    const participant = await addParticipant(eventId, req.auth!.userId, input);
    res.status(201).json({ data: toParticipantSummary(participant) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/events/:eventId/participants/:participantId
export async function updateParticipantController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    const input = updateParticipantSchema.parse(req.body);
    traceLog("participants.controller.updateParticipantController", {
      eventId,
      participantId,
      userId: req.auth!.userId,
    });
    const participant = await editParticipant(eventId, req.auth!.userId, participantId, input);
    res.status(200).json({ data: toParticipantSummary(participant) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/events/:eventId/participants/:participantId
export async function deleteParticipantController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    traceLog("participants.controller.deleteParticipantController", {
      eventId,
      participantId,
      userId: req.auth!.userId,
    });
    await removeParticipant(eventId, req.auth!.userId, participantId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/participants/:participantId/approve
export async function approveParticipantController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    traceLog("participants.controller.approveParticipantController", {
      eventId,
      participantId,
      userId: req.auth!.userId,
    });
    const participant = await approveParticipant(eventId, req.auth!.userId, participantId);
    res.status(200).json({ data: toParticipantSummary(participant) });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/participants/:participantId/reject
export async function rejectParticipantController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    traceLog("participants.controller.rejectParticipantController", {
      eventId,
      participantId,
      userId: req.auth!.userId,
    });
    const participant = await rejectParticipant(eventId, req.auth!.userId, participantId);
    res.status(200).json({ data: toParticipantSummary(participant) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/events/:eventId/participants/:participantId/attendance
export async function setAttendanceController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    const { status } = setAttendanceSchema.parse(req.body);
    traceLog("participants.controller.setAttendanceController", {
      eventId,
      participantId,
      userId: req.auth!.userId,
      status,
    });
    const participant = await setAttendance(eventId, req.auth!.userId, participantId, status);
    res.status(200).json({ data: toParticipantSummary(participant) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/events/:eventId/participants/:participantId/result
export async function setResultController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    const input = setResultSchema.parse(req.body);
    traceLog("participants.controller.setResultController", {
      eventId,
      participantId,
      userId: req.auth!.userId,
      status: input.status,
    });
    const participant = await setResult(eventId, req.auth!.userId, participantId, input);
    res.status(200).json({ data: toParticipantSummary(participant) });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/participants/import
export async function bulkAddParticipantsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { eventId } = participantsEventIdParamSchema.parse(req.params);
    const { participants } = bulkAddParticipantsSchema.parse(req.body);
    traceLog("participants.controller.bulkAddParticipantsController", {
      eventId,
      userId: req.auth!.userId,
      count: participants.length,
    });
    const created = await addParticipants(eventId, req.auth!.userId, participants);
    res.status(201).json({ data: created.map(toParticipantSummary) });
  } catch (err) {
    next(err);
  }
}
