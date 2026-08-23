// Teams (clubs) and following an organizer.
//
// "Pro teams have rides a few times a week ... all members can see the schedule, sometimes I
// invite new riders and I approve them." A team is a real entity rather than a free-text name
// so its rides can gather under one banner — which events.organizer_group, being a string,
// cannot do.
//
// Membership deliberately mirrors event_participants: a member may have no account yet,
// because they were added by hand, from a spreadsheet, or from phone contacts.

import type { Team, TeamMember, TeamMemberStatus } from "../db/types.js";
import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import { buildActor } from "../authz/actor.js";
import { assertWithinTeamLimit } from "../authz/limits.js";
import { selectEventById } from "../queries/event.queries.js";
import { assertOwner } from "./event.service.js";
import {
  countFollowers,
  countTeamsForOwner,
  deleteFollow,
  deleteMember,
  deleteTeam,
  insertFollow,
  insertTeam,
  insertTeamMembers,
  type NewTeamMemberRow,
  selectFollowingIds,
  selectMemberById,
  selectMemberByUser,
  selectMembersForTeam,
  selectTeamById,
  selectTeamsForUser,
  setEventTeam,
  updateMemberStatus,
  updateTeam,
} from "../queries/team.queries.js";

async function assertTeamOwner(teamId: number, userId: number): Promise<Team> {
  const team = await selectTeamById(teamId);
  if (!team) throw new ApiError(404, "Team not found");
  if (team.ownerId !== userId) throw new ApiError(403, "Only the team owner may do this");
  return team;
}

export async function createTeam(
  ownerId: number,
  input: { name: string; avatarUrl?: string },
): Promise<Team> {
  const [actor, current] = await Promise.all([
    buildActor(ownerId),
    countTeamsForOwner(ownerId),
  ]);
  assertWithinTeamLimit(actor, current);
  const team = await insertTeam({
    name: input.name,
    ownerId,
    avatarUrl: input.avatarUrl ?? null,
  });
  logger.info({ teamId: team.id, ownerId }, "team created");
  return team;
}

export function listMyTeams(userId: number): Promise<Team[]> {
  return selectTeamsForUser(userId);
}

/**
 * A team is readable by its owner and by anyone on its roster — including someone still
 * waiting, who needs to see what they asked to join. It is not public: a club's membership
 * list is not a browse surface.
 */
export async function getTeamForViewer(teamId: number, viewerId: number): Promise<Team> {
  const team = await selectTeamById(teamId);
  if (!team) throw new ApiError(404, "Team not found");
  if (team.ownerId === viewerId) return team;
  const membership = await selectMemberByUser(teamId, viewerId);
  if (!membership) throw new ApiError(404, "Team not found");
  return team;
}

export async function editTeam(
  teamId: number,
  userId: number,
  input: { name?: string; avatarUrl?: string },
): Promise<Team> {
  await assertTeamOwner(teamId, userId);
  const updated = await updateTeam(teamId, input);
  if (!updated) throw new Error(`editTeam: team ${teamId} not found after update`);
  return updated;
}

export async function removeTeam(teamId: number, userId: number): Promise<void> {
  await assertTeamOwner(teamId, userId);
  await deleteTeam(teamId);
  logger.info({ teamId, userId }, "team removed");
}

// ---- membership ----------------------------------------------------------------------------

export async function listMembers(teamId: number, viewerId: number): Promise<TeamMember[]> {
  await getTeamForViewer(teamId, viewerId);
  return selectMembersForTeam(teamId);
}

/**
 * Organizer-added members are approved outright — the direct add IS the approval ("or I
 * approved by invitation"), the same convention manual participant entry follows.
 */
export async function addMembers(
  teamId: number,
  userId: number,
  rows: { name: string; email?: string; phone?: string }[],
): Promise<TeamMember[]> {
  await assertTeamOwner(teamId, userId);
  const members: NewTeamMemberRow[] = rows.map((input) => ({
    userId: null,
    name: input.name,
    email: input.email ?? null,
    phone: input.phone ?? null,
    status: "approved",
  }));
  const created = await insertTeamMembers(teamId, members);
  logger.info({ teamId, userId, count: created.length }, "team members added");
  return created;
}

/**
 * A rider asking to join a team themselves. Lands as `waiting_approval` — the owner decides.
 * Idempotent: asking twice returns the existing row rather than erroring, since the app may
 * retry after a dropped connection.
 */
export async function requestToJoinTeam(teamId: number, userId: number): Promise<TeamMember> {
  const team = await selectTeamById(teamId);
  if (!team) throw new ApiError(404, "Team not found");
  if (team.ownerId === userId) throw new ApiError(400, "You already own this team");

  const existing = await selectMemberByUser(teamId, userId);
  if (existing) return existing;

  const [created] = await insertTeamMembers(teamId, [
    { userId, name: null, email: null, phone: null, status: "waiting_approval" },
  ]);
  logger.info({ teamId, userId, memberId: created.id }, "team join requested");
  return created;
}

export async function setMemberStatus(
  teamId: number,
  userId: number,
  memberId: number,
  status: TeamMemberStatus,
): Promise<TeamMember> {
  await assertTeamOwner(teamId, userId);
  const updated = await updateMemberStatus(memberId, teamId, status);
  if (!updated) throw new ApiError(404, "Team member not found");
  logger.info({ teamId, userId, memberId, status }, "team member status changed");
  return updated;
}

export async function removeMember(
  teamId: number,
  userId: number,
  memberId: number,
): Promise<void> {
  await assertTeamOwner(teamId, userId);
  const existing = await selectMemberById(memberId, teamId);
  if (!existing) throw new ApiError(404, "Team member not found");
  await deleteMember(memberId, teamId);
}

// ---- a team's schedule -----------------------------------------------------------------------

/**
 * Linking a ride to a team requires owning BOTH — the ride, so nobody re-files someone else's
 * event, and the team, so nobody hangs their ride off a club they do not run.
 */
export async function linkEventToTeam(
  eventId: string,
  userId: number,
  teamId: number | null,
): Promise<void> {
  const event = await selectEventById(eventId);
  if (!event) throw new ApiError(404, "Event not found");
  assertOwner(event, userId);
  if (teamId !== null) await assertTeamOwner(teamId, userId);
  await setEventTeam(eventId, teamId);
  logger.info({ eventId, userId, teamId }, "event team link changed");
}

// ---- following -------------------------------------------------------------------------------

export async function followUser(followerId: number, followeeId: number): Promise<void> {
  if (followerId === followeeId) throw new ApiError(400, "You cannot follow yourself");
  await insertFollow(followerId, followeeId);
  logger.info({ followerId, followeeId }, "user followed");
}

export async function unfollowUser(followerId: number, followeeId: number): Promise<void> {
  await deleteFollow(followerId, followeeId);
}

export function listFollowing(followerId: number): Promise<number[]> {
  return selectFollowingIds(followerId);
}

export function getFollowerCount(followeeId: number): Promise<number> {
  return countFollowers(followeeId);
}
