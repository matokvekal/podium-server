import { Router } from "express";
import { deduplicateClientAction } from "../../middleware/clientActions.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import {
  addMembersHandler,
  createTeamHandler,
  deleteTeamHandler,
  getTeamHandler,
  joinTeamHandler,
  listMembersHandler,
  listTeamsHandler,
  removeMemberHandler,
  setMemberStatusHandler,
  updateTeamHandler,
} from "./team.controller.js";

export const teamRouter = Router();

// Everything here requires an account. A club's membership list is not a browse surface —
// unlike public events and the route library, there is no guest view of a team.
teamRouter.post("/", requireAuth, deduplicateClientAction, createTeamHandler);
teamRouter.get("/", requireAuth, listTeamsHandler);

teamRouter.get("/:teamId", requireAuth, getTeamHandler);
teamRouter.patch("/:teamId", requireAuth, deduplicateClientAction, updateTeamHandler);
teamRouter.delete("/:teamId", requireAuth, deduplicateClientAction, deleteTeamHandler);

teamRouter.get("/:teamId/members", requireAuth, listMembersHandler);
teamRouter.post("/:teamId/members", requireAuth, deduplicateClientAction, addMembersHandler);
teamRouter.patch(
  "/:teamId/members/:memberId",
  requireAuth,
  deduplicateClientAction,
  setMemberStatusHandler,
);
teamRouter.delete(
  "/:teamId/members/:memberId",
  requireAuth,
  deduplicateClientAction,
  removeMemberHandler,
);

// A rider asking to join, as opposed to the owner adding them: lands as waiting_approval.
teamRouter.post("/:teamId/join", requireAuth, joinTeamHandler);
