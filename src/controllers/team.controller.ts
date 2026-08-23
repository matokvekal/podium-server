import type { NextFunction, Request, Response } from "express";
import type { Team, TeamMember } from "../db/types.js";
import { traceLog } from "../lib/trace-log.js";
import { eventIdParamSchema } from "../schemas/event.schemas.js";
import {
  addTeamMembersSchema,
  createTeamSchema,
  followParamSchema,
  linkEventTeamSchema,
  setMemberStatusSchema,
  teamIdParamSchema,
  teamMemberParamSchema,
  updateTeamSchema,
} from "../schemas/team.schemas.js";
import {
  addMembers,
  createTeam,
  editTeam,
  followUser,
  getFollowerCount,
  getTeamForViewer,
  linkEventToTeam,
  listFollowing,
  listMembers,
  listMyTeams,
  removeMember,
  removeTeam,
  requestToJoinTeam,
  setMemberStatus,
  unfollowUser,
} from "../services/team.service.js";

function toTeam(team: Team) {
  return {
    id: team.id,
    name: team.name,
    ownerId: team.ownerId,
    avatarUrl: team.avatarUrl,
    createdAt: team.createdAt,
  };
}

function toMember(member: TeamMember) {
  return {
    id: member.id,
    teamId: member.teamId,
    userId: member.userId,
    name: member.name,
    avatarUrl: member.avatarUrl,
    email: member.email,
    phone: member.phone,
    status: member.status,
  };
}

// POST /api/v1/teams
export async function createTeamController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createTeamSchema.parse(req.body);
    traceLog("team.controller.createTeamController", { userId: req.auth!.userId, name: input.name });
    const team = await createTeam(req.auth!.userId, input);
    res.status(201).json({ data: toTeam(team) });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/teams
export async function listTeamsController(req: Request, res: Response, next: NextFunction) {
  try {
    traceLog("team.controller.listTeamsController", { userId: req.auth!.userId });
    const teams = await listMyTeams(req.auth!.userId);
    res.status(200).json({ data: teams.map(toTeam) });
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/teams/:teamId
export async function getTeamController(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    traceLog("team.controller.getTeamController", { teamId, userId: req.auth!.userId });
    const team = await getTeamForViewer(teamId, req.auth!.userId);
    res.status(200).json({
      data: { ...toTeam(team), isOwner: team.ownerId === req.auth!.userId },
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/teams/:teamId
export async function updateTeamController(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    const input = updateTeamSchema.parse(req.body);
    traceLog("team.controller.updateTeamController", { teamId, userId: req.auth!.userId });
    const team = await editTeam(teamId, req.auth!.userId, input);
    res.status(200).json({ data: toTeam(team) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/teams/:teamId
export async function deleteTeamController(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    traceLog("team.controller.deleteTeamController", { teamId, userId: req.auth!.userId });
    await removeTeam(teamId, req.auth!.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/teams/:teamId/members
export async function listMembersController(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    traceLog("team.controller.listMembersController", { teamId, userId: req.auth!.userId });
    const members = await listMembers(teamId, req.auth!.userId);
    res.status(200).json({ data: members.map(toMember) });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/teams/:teamId/members
export async function addMembersController(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    const { members } = addTeamMembersSchema.parse(req.body);
    traceLog("team.controller.addMembersController", {
      teamId,
      userId: req.auth!.userId,
      count: members.length,
    });
    const created = await addMembers(teamId, req.auth!.userId, members);
    res.status(201).json({ data: created.map(toMember) });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/teams/:teamId/join
export async function joinTeamController(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    traceLog("team.controller.joinTeamController", { teamId, userId: req.auth!.userId });
    const member = await requestToJoinTeam(teamId, req.auth!.userId);
    res.status(200).json({ data: toMember(member) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/v1/teams/:teamId/members/:memberId
export async function setMemberStatusController(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId, memberId } = teamMemberParamSchema.parse(req.params);
    const { status } = setMemberStatusSchema.parse(req.body);
    traceLog("team.controller.setMemberStatusController", {
      teamId,
      memberId,
      userId: req.auth!.userId,
      status,
    });
    const member = await setMemberStatus(teamId, req.auth!.userId, memberId, status);
    res.status(200).json({ data: toMember(member) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/teams/:teamId/members/:memberId
export async function removeMemberController(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId, memberId } = teamMemberParamSchema.parse(req.params);
    traceLog("team.controller.removeMemberController", {
      teamId,
      memberId,
      userId: req.auth!.userId,
    });
    await removeMember(teamId, req.auth!.userId, memberId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

/** Mounted under the event router: PATCH /events/:eventId/team. */
// PATCH /api/v1/events/:eventId/team
export async function linkEventTeamController(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { teamId } = linkEventTeamSchema.parse(req.body);
    traceLog("team.controller.linkEventTeamController", {
      eventId,
      teamId,
      userId: req.auth!.userId,
    });
    await linkEventToTeam(eventId, req.auth!.userId, teamId);
    res.status(200).json({ data: { eventId, teamId } });
  } catch (err) {
    next(err);
  }
}

// ---- following --------------------------------------------------------------------------

// PUT /api/v1/users/:userId/follow
export async function followController(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = followParamSchema.parse(req.params);
    traceLog("team.controller.followController", { followerId: req.auth!.userId, followeeId: userId });
    await followUser(req.auth!.userId, userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// DELETE /api/v1/users/:userId/follow
export async function unfollowController(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = followParamSchema.parse(req.params);
    traceLog("team.controller.unfollowController", {
      followerId: req.auth!.userId,
      followeeId: userId,
    });
    await unfollowUser(req.auth!.userId, userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/users/me/following
export async function listFollowingController(req: Request, res: Response, next: NextFunction) {
  try {
    traceLog("team.controller.listFollowingController", { userId: req.auth!.userId });
    const following = await listFollowing(req.auth!.userId);
    res.status(200).json({ data: { following, followers: await getFollowerCount(req.auth!.userId) } });
  } catch (err) {
    next(err);
  }
}
