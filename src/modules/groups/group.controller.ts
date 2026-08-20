import type { NextFunction, Request, Response } from "express";
import type { EventGroup } from "../../db/types.js";
import { traceLog } from "../../lib/trace-log.js";
import { eventIdParamSchema } from "../events/event.schemas.js";
import {
  assignRidersSchema,
  createGroupSchema,
  groupIdParamSchema,
  updateGroupSchema,
} from "./group.schemas.js";
import {
  assignRiders,
  createGroup,
  editGroup,
  listGroupsForViewer,
  removeGroup,
} from "./group.service.js";

function toGroup(group: EventGroup) {
  return {
    id: group.id,
    eventId: group.eventId,
    name: group.name,
    /** null means "starts with the event" — not "unknown". */
    startsAt: group.startsAt,
    /** null means "uses the event's route". Geometry comes from GET /routes/:routeId. */
    routeId: group.routeId,
    sortOrder: group.sortOrder,
  };
}

export async function listGroupsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("group.controller.listGroupsHandler", { eventId, viewerId });
    const groups = await listGroupsForViewer(eventId, viewerId);
    res.status(200).json({ data: groups.map(toGroup) });
  } catch (err) {
    next(err);
  }
}

export async function createGroupHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const input = createGroupSchema.parse(req.body);
    traceLog("group.controller.createGroupHandler", {
      eventId,
      userId: req.auth!.userId,
      name: input.name,
    });
    const group = await createGroup(eventId, req.auth!.userId, input);
    res.status(201).json({ data: toGroup(group) });
  } catch (err) {
    next(err);
  }
}

export async function updateGroupHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, groupId } = groupIdParamSchema.parse(req.params);
    const input = updateGroupSchema.parse(req.body);
    traceLog("group.controller.updateGroupHandler", {
      eventId,
      groupId,
      userId: req.auth!.userId,
    });
    const group = await editGroup(eventId, req.auth!.userId, groupId, input);
    res.status(200).json({ data: toGroup(group) });
  } catch (err) {
    next(err);
  }
}

export async function deleteGroupHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, groupId } = groupIdParamSchema.parse(req.params);
    traceLog("group.controller.deleteGroupHandler", {
      eventId,
      groupId,
      userId: req.auth!.userId,
    });
    await removeGroup(eventId, req.auth!.userId, groupId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function assignRidersHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { participantIds, groupId } = assignRidersSchema.parse(req.body);
    traceLog("group.controller.assignRidersHandler", {
      eventId,
      userId: req.auth!.userId,
      groupId,
      count: participantIds.length,
    });
    const assigned = await assignRiders(eventId, req.auth!.userId, participantIds, groupId);
    res.status(200).json({ data: { assigned } });
  } catch (err) {
    next(err);
  }
}
