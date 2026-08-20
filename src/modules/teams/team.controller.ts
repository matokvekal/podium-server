import type { NextFunction, Request, Response } from "express";
import type { Team, TeamMember } from "../../db/types.js";
import { traceLog } from "../../lib/trace-log.js";
import { eventIdParamSchema } from "../events/event.schemas.js";
import {
  addTeamMembersSchema,
  createTeamSchema,
  followParamSchema,
  linkEventTeamSchema,
  setMemberStatusSchema,
  teamIdParamSchema,
  teamMemberParamSchema,
  updateTeamSchema,
} from "./team.schemas.js";
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
} from "./team.service.js";

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

export async function createTeamHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const input = createTeamSchema.parse(req.body);
    traceLog("team.controller.createTeamHandler", { userId: req.auth!.userId, name: input.name });
    const team = await createTeam(req.auth!.userId, input);
    res.status(201).json({ data: toTeam(team) });
  } catch (err) {
    next(err);
  }
}

export async function listTeamsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    traceLog("team.controller.listTeamsHandler", { userId: req.auth!.userId });
    const teams = await listMyTeams(req.auth!.userId);
    res.status(200).json({ data: teams.map(toTeam) });
  } catch (err) {
    next(err);
  }
}

export async function getTeamHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    traceLog("team.controller.getTeamHandler", { teamId, userId: req.auth!.userId });
    const team = await getTeamForViewer(teamId, req.auth!.userId);
    res.status(200).json({
      data: { ...toTeam(team), isOwner: team.ownerId === req.auth!.userId },
    });
  } catch (err) {
    next(err);
  }
}

export async function updateTeamHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    const input = updateTeamSchema.parse(req.body);
    traceLog("team.controller.updateTeamHandler", { teamId, userId: req.auth!.userId });
    const team = await editTeam(teamId, req.auth!.userId, input);
    res.status(200).json({ data: toTeam(team) });
  } catch (err) {
    next(err);
  }
}

export async function deleteTeamHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    traceLog("team.controller.deleteTeamHandler", { teamId, userId: req.auth!.userId });
    await removeTeam(teamId, req.auth!.userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function listMembersHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    traceLog("team.controller.listMembersHandler", { teamId, userId: req.auth!.userId });
    const members = await listMembers(teamId, req.auth!.userId);
    res.status(200).json({ data: members.map(toMember) });
  } catch (err) {
    next(err);
  }
}

export async function addMembersHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    const { members } = addTeamMembersSchema.parse(req.body);
    traceLog("team.controller.addMembersHandler", {
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

export async function joinTeamHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId } = teamIdParamSchema.parse(req.params);
    traceLog("team.controller.joinTeamHandler", { teamId, userId: req.auth!.userId });
    const member = await requestToJoinTeam(teamId, req.auth!.userId);
    res.status(200).json({ data: toMember(member) });
  } catch (err) {
    next(err);
  }
}

export async function setMemberStatusHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId, memberId } = teamMemberParamSchema.parse(req.params);
    const { status } = setMemberStatusSchema.parse(req.body);
    traceLog("team.controller.setMemberStatusHandler", {
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

export async function removeMemberHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { teamId, memberId } = teamMemberParamSchema.parse(req.params);
    traceLog("team.controller.removeMemberHandler", {
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
export async function linkEventTeamHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { eventId } = eventIdParamSchema.parse(req.params);
    const { teamId } = linkEventTeamSchema.parse(req.body);
    traceLog("team.controller.linkEventTeamHandler", {
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

export async function followHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = followParamSchema.parse(req.params);
    traceLog("team.controller.followHandler", { followerId: req.auth!.userId, followeeId: userId });
    await followUser(req.auth!.userId, userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function unfollowHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = followParamSchema.parse(req.params);
    traceLog("team.controller.unfollowHandler", {
      followerId: req.auth!.userId,
      followeeId: userId,
    });
    await unfollowUser(req.auth!.userId, userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function listFollowingHandler(req: Request, res: Response, next: NextFunction) {
  try {
    traceLog("team.controller.listFollowingHandler", { userId: req.auth!.userId });
    const following = await listFollowing(req.auth!.userId);
    res.status(200).json({ data: { following, followers: await getFollowerCount(req.auth!.userId) } });
  } catch (err) {
    next(err);
  }
}
