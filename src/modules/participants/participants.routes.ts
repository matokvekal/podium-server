import { Router } from "express";
import { deduplicateClientAction } from "../../middleware/clientActions.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import {
  addParticipantHandler,
  approveParticipantHandler,
  bulkAddParticipantsHandler,
  deleteParticipantHandler,
  listParticipantsHandler,
  rejectParticipantHandler,
  setAttendanceHandler,
  setResultHandler,
  updateParticipantHandler,
} from "./participants.controller.js";

// mergeParams: true so :eventId from the parent mount (event.routes.ts) is visible here.
export const participantsRouter = Router({ mergeParams: true });

// requireAuth even on the list: an anonymous or unregistered viewer can never pass
// listParticipantsForViewer's checks anyway (owner or a registered/approved rider only), so
// there is nothing an anonymous caller could see here.
participantsRouter.get("/", requireAuth, listParticipantsHandler);
// Every mutation here carries the offline-replay guard: adding a rider twice is the exact
// failure sql/006-client-actions.sql was written for.
participantsRouter.post("/", requireAuth, deduplicateClientAction, addParticipantHandler);
// Spreadsheet / contacts import, in one transaction. Registered before "/:participantId"
// routes so the literal path is never taken for a participant id.
participantsRouter.post(
  "/import",
  requireAuth,
  deduplicateClientAction,
  bulkAddParticipantsHandler,
);
participantsRouter.patch(
  "/:participantId",
  requireAuth,
  deduplicateClientAction,
  updateParticipantHandler,
);
participantsRouter.delete(
  "/:participantId",
  requireAuth,
  deduplicateClientAction,
  deleteParticipantHandler,
);
participantsRouter.post(
  "/:participantId/approve",
  requireAuth,
  deduplicateClientAction,
  approveParticipantHandler,
);
participantsRouter.post(
  "/:participantId/reject",
  requireAuth,
  deduplicateClientAction,
  rejectParticipantHandler,
);

// The other two status axes. Three axes, three endpoints, never one merged field — see
// sql/003-participants.sql.
participantsRouter.patch(
  "/:participantId/attendance",
  requireAuth,
  deduplicateClientAction,
  setAttendanceHandler,
);
participantsRouter.patch(
  "/:participantId/result",
  requireAuth,
  deduplicateClientAction,
  setResultHandler,
);
