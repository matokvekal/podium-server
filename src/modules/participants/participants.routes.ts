import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth.js";
import {
  addParticipantHandler,
  approveParticipantHandler,
  deleteParticipantHandler,
  listParticipantsHandler,
  rejectParticipantHandler,
  updateParticipantHandler,
} from "./participants.controller.js";

// mergeParams: true so :eventId from the parent mount (event.routes.ts) is visible here.
export const participantsRouter = Router({ mergeParams: true });

// requireAuth even on the list: an anonymous or unregistered viewer can never pass
// listParticipantsForViewer's checks anyway (owner or a registered/approved rider only), so
// there is nothing an anonymous caller could see here.
participantsRouter.get("/", requireAuth, listParticipantsHandler);
participantsRouter.post("/", requireAuth, addParticipantHandler);
participantsRouter.patch("/:participantId", requireAuth, updateParticipantHandler);
participantsRouter.delete("/:participantId", requireAuth, deleteParticipantHandler);
participantsRouter.post("/:participantId/approve", requireAuth, approveParticipantHandler);
participantsRouter.post("/:participantId/reject", requireAuth, rejectParticipantHandler);
