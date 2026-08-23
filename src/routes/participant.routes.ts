// Routes for PARTICIPANTS (the riders registered to an event).
//
// Mounted by event.routes.ts at "/:eventId/participants", so every path below is
// /api/v1/events/:eventId/participants.

import { Router } from "express";
import {
  addParticipantController,
  approveParticipantController,
  bulkAddParticipantsController,
  deleteParticipantController,
  listParticipantsController,
  rejectParticipantController,
  setAttendanceController,
  setResultController,
  updateParticipantController,
} from "../controllers/participant.controller.js";
import { deduplicateClientAction } from "../middleware/clientActions.js";
import { requireAuth } from "../middleware/requireAuth.js";

// mergeParams: true so :eventId from the parent mount (event.routes.ts) is visible here.
export const participantRouter = Router({ mergeParams: true });

// Every mutation below carries deduplicateClientAction, the offline-replay guard: adding a
// rider twice is the exact failure sql/006-client-actions.sql was written for.

// GET /api/v1/events/:eventId/participants
// requireAuth even on the list: an anonymous or unregistered viewer can never pass
// listParticipantsForViewer's checks anyway (owner or a registered/approved rider only), so
// there is nothing an anonymous caller could see here.
participantRouter.get("/", requireAuth, listParticipantsController);

// POST /api/v1/events/:eventId/participants
participantRouter.post("/", requireAuth, deduplicateClientAction, addParticipantController);

// POST /api/v1/events/:eventId/participants/import
// Spreadsheet / contacts import, in one transaction. Registered before the "/:participantId"
// routes so the literal path is never taken for a participant id.
participantRouter.post(
  "/import",
  requireAuth,
  deduplicateClientAction,
  bulkAddParticipantsController,
);

// PATCH /api/v1/events/:eventId/participants/:participantId
participantRouter.patch(
  "/:participantId",
  requireAuth,
  deduplicateClientAction,
  updateParticipantController,
);

// DELETE /api/v1/events/:eventId/participants/:participantId
participantRouter.delete(
  "/:participantId",
  requireAuth,
  deduplicateClientAction,
  deleteParticipantController,
);

// POST /api/v1/events/:eventId/participants/:participantId/approve
participantRouter.post(
  "/:participantId/approve",
  requireAuth,
  deduplicateClientAction,
  approveParticipantController,
);

// POST /api/v1/events/:eventId/participants/:participantId/reject
participantRouter.post(
  "/:participantId/reject",
  requireAuth,
  deduplicateClientAction,
  rejectParticipantController,
);

// The other two status axes. Three axes, three endpoints, never one merged field — see
// sql/003-participants.sql.

// PATCH /api/v1/events/:eventId/participants/:participantId/attendance
participantRouter.patch(
  "/:participantId/attendance",
  requireAuth,
  deduplicateClientAction,
  setAttendanceController,
);

// PATCH /api/v1/events/:eventId/participants/:participantId/result
participantRouter.patch(
  "/:participantId/result",
  requireAuth,
  deduplicateClientAction,
  setResultController,
);
