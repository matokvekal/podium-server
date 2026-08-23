// Routes for TEAMS (clubs) — mounted by app.ts at "/api/v1/teams".
//
// Everything here requires an account. A club's membership list is not a browse surface —
// unlike public events and the route library, there is no guest view of a team.
//
// Note: the follow/unfollow endpoints are also served by team.controller.ts, but they live
// under /api/v1/users/* — see user.routes.ts.

import { Router } from "express";
import {
  addMembersController,
  createTeamController,
  deleteTeamController,
  getTeamController,
  joinTeamController,
  listMembersController,
  listTeamsController,
  removeMemberController,
  setMemberStatusController,
  updateTeamController,
} from "../controllers/team.controller.js";
import { deduplicateClientAction } from "../middleware/clientActions.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const teamRouter = Router();

// POST /api/v1/teams
teamRouter.post("/", requireAuth, deduplicateClientAction, createTeamController);

// GET /api/v1/teams
teamRouter.get("/", requireAuth, listTeamsController);

// GET /api/v1/teams/:teamId
teamRouter.get("/:teamId", requireAuth, getTeamController);

// PATCH /api/v1/teams/:teamId
teamRouter.patch("/:teamId", requireAuth, deduplicateClientAction, updateTeamController);

// DELETE /api/v1/teams/:teamId
teamRouter.delete("/:teamId", requireAuth, deduplicateClientAction, deleteTeamController);

// GET /api/v1/teams/:teamId/members
teamRouter.get("/:teamId/members", requireAuth, listMembersController);

// POST /api/v1/teams/:teamId/members
teamRouter.post("/:teamId/members", requireAuth, deduplicateClientAction, addMembersController);

// PATCH /api/v1/teams/:teamId/members/:memberId
teamRouter.patch(
  "/:teamId/members/:memberId",
  requireAuth,
  deduplicateClientAction,
  setMemberStatusController,
);

// DELETE /api/v1/teams/:teamId/members/:memberId
teamRouter.delete(
  "/:teamId/members/:memberId",
  requireAuth,
  deduplicateClientAction,
  removeMemberController,
);

// POST /api/v1/teams/:teamId/join
// A rider asking to join, as opposed to the owner adding them: lands as waiting_approval.
teamRouter.post("/:teamId/join", requireAuth, joinTeamController);
