import type { NextFunction, Request, Response } from "express";
import type { EventGroup } from "../db/types.js";
import { traceLog } from "../lib/trace-log.js";
import { eventIdParamSchema } from "../schemas/event.schemas.js";
import {
  assignRidersSchema,
  createGroupSchema,
  groupIdParamSchema,
  updateGroupSchema,
} from "../schemas/group.schemas.js";
import {
  assignRiders,
  createGroup,
  editGroup,
  listGroupsForViewer,
  removeGroup,
} from "../services/group.service.js";

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

// GET /api/v1/events/:eventId/groups
export async function listGroupsController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const viewerId = req.auth?.userId ?? null;
    traceLog("group.controller.listGroupsController", { eventId, viewerId });
    const groups = await listGroupsForViewer(eventId, viewerId);
    res.status(200).json({ data: groups.map(toGroup) });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/events/:eventId/groups
export async function createGroupController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const input = createGroupSchema.parse(req.body);
    traceLog("group.controller.createGroupController", {
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

// PATCH /api/v1/events/:eventId/groups/:groupId
export async function updateGroupController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, groupId } = groupIdParamSchema.parse(req.params);
    const input = updateGroupSchema.parse(req.body);
    traceLog("group.controller.updateGroupController", {
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

// DELETE /api/v1/events/:eventId/groups/:groupId
export async function deleteGroupController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId, groupId } = groupIdParamSchema.parse(req.params);
    traceLog("group.controller.deleteGroupController", {
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

// POST /api/v1/events/:eventId/groups/assign
export async function assignRidersController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { participantIds, groupId } = assignRidersSchema.parse(req.body);
    traceLog("group.controller.assignRidersController", {
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
