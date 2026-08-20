import type { NextFunction, Request, Response } from "express";
import type { EventParticipant } from "../../db/types.js";
import { traceLog } from "../../lib/trace-log.js";
import {
  addParticipantSchema,
  bulkAddParticipantsSchema,
  participantIdParamSchema,
  participantsEventIdParamSchema,
  setAttendanceSchema,
  setResultSchema,
  updateParticipantSchema,
} from "./participants.schemas.js";
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
} from "./participants.service.js";

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

export async function listParticipantsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = participantsEventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("participants.controller.listParticipantsHandler", { eventId, viewerId });
    const participants = await listParticipantsForViewer(eventId, viewerId);
    res.status(200).json({ data: participants.map(toParticipantSummary) });
  } catch (err) {
    next(err);
  }
}

export async function addParticipantHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = participantsEventIdParamSchema.parse(req.params);
    const input = addParticipantSchema.parse(req.body);
    traceLog("participants.controller.addParticipantHandler", {
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

export async function updateParticipantHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    const input = updateParticipantSchema.parse(req.body);
    traceLog("participants.controller.updateParticipantHandler", {
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

export async function deleteParticipantHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    traceLog("participants.controller.deleteParticipantHandler", {
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

export async function approveParticipantHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    traceLog("participants.controller.approveParticipantHandler", {
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

export async function rejectParticipantHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    traceLog("participants.controller.rejectParticipantHandler", {
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

export async function setAttendanceHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    const { status } = setAttendanceSchema.parse(req.body);
    traceLog("participants.controller.setAttendanceHandler", {
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

export async function setResultHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, participantId } = participantIdParamSchema.parse(req.params);
    const input = setResultSchema.parse(req.body);
    traceLog("participants.controller.setResultHandler", {
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

export async function bulkAddParticipantsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { eventId } = participantsEventIdParamSchema.parse(req.params);
    const { participants } = bulkAddParticipantsSchema.parse(req.body);
    traceLog("participants.controller.bulkAddParticipantsHandler", {
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
