import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import { traceLog } from "../lib/trace-log.js";
import {
  type AdminRideRow,
  selectUpcomingRidesForAdmin,
  updateRideMaxParticipants,
} from "../queries/adminRides.queries.js";
import { setRideMaxParticipantsSchema } from "../schemas/adminRides.schemas.js";
import { eventIdParamSchema } from "../schemas/event.schemas.js";

function toAdminRideDto(row: AdminRideRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    startsAt: row.starts_at,
    status: row.status,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    ownerLimit: row.owner_limit,
    maxParticipants: row.max_participants,
    participantCount: Number(row.participant_count),
  };
}

/** GET /api/v1/admin/rides — upcoming rides with their rider caps. */
export async function adminListRidesController(_req: Request, res: Response, next: NextFunction) {
  traceLog("adminRides.controller.adminListRidesController");
  try {
    const rows = await selectUpcomingRidesForAdmin();
    res.status(200).json({ data: rows.map(toAdminRideDto) });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/v1/admin/rides/:eventId — `{ maxParticipants: number | null }`. */
export async function adminSetRideMaxParticipantsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  traceLog("adminRides.controller.adminSetRideMaxParticipantsController");
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { maxParticipants } = setRideMaxParticipantsSchema.parse(req.body);
    const row = await updateRideMaxParticipants(eventId, maxParticipants);
    if (!row) throw new ApiError(404, "Event not found");
    logger.info(
      { eventId, maxParticipants, adminUserId: req.auth?.userId },
      "admin set ride rider cap",
    );
    res.status(200).json({ data: toAdminRideDto(row) });
  } catch (err) {
    next(err);
  }
}
