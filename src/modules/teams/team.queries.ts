// SQL for teams, team_members and user_follows.

import { execute, query, queryOne, withTransaction } from "../../db/pool.js";
import type { Team, TeamMember, TeamMemberStatus } from "../../db/types.js";

interface TeamRow {
  id: number;
  name: string;
  owner_id: number;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
}

interface TeamMemberRow {
  id: number;
  team_id: number;
  user_id: number | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: TeamMemberStatus;
  created_at: Date;
  updated_at: Date;
  /** Joined from users — same read-time resolution the start list uses. */
  display_name?: string | null;
  avatar_url?: string | null;
}

function mapTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMember(row: TeamMemberRow): TeamMember {
  return {
    id: row.id,
    teamId: row.team_id,
    userId: row.user_id,
    // Same rule as event participants: the row's own name when set, otherwise the linked
    // account's, resolved on read so fixing a profile fixes it everywhere.
    name: row.display_name ?? row.name,
    avatarUrl: row.avatar_url ?? null,
    email: row.email,
    phone: row.phone,
    status: row.status,
    createdAt: row.created_at,
  };
}

const MEMBER_DISPLAY_COLUMNS = `
  COALESCE(
    tm.name,
    NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
    u.nickname
  ) AS display_name,
  u.avatar_url`;

export async function insertTeam(input: {
  name: string;
  ownerId: number;
  avatarUrl: string | null;
}): Promise<Team> {
  const row = await queryOne<TeamRow>(
    "INSERT INTO teams (name, owner_id, avatar_url) VALUES ($1, $2, $3) RETURNING *",
    [input.name, input.ownerId, input.avatarUrl],
  );
  if (!row) throw new Error("insertTeam returned no row");
  return mapTeam(row);
}

export async function selectTeamById(teamId: number): Promise<Team | null> {
  const row = await queryOne<TeamRow>("SELECT * FROM teams WHERE id = $1", [teamId]);
  return row ? mapTeam(row) : null;
}

export async function countTeamsForOwner(ownerId: number): Promise<number> {
  const row = await queryOne<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM teams WHERE owner_id = $1",
    [ownerId],
  );
  return Number(row?.count ?? 0);
}

/**
 * "My teams" means the ones I own AND the ones I am an approved member of. The client could
 * only ever show "teams I created", because a membership row had no real account link — that
 * was the whole limitation this table fixes.
 */
export async function selectTeamsForUser(userId: number): Promise<Team[]> {
  const rows = await query<TeamRow>(
    `SELECT DISTINCT t.* FROM teams t
       LEFT JOIN team_members tm
              ON tm.team_id = t.id AND tm.user_id = $1 AND tm.status = 'approved'
      WHERE t.owner_id = $1 OR tm.user_id = $1
      ORDER BY t.created_at DESC`,
    [userId],
  );
  return rows.map(mapTeam);
}

export async function updateTeam(
  teamId: number,
  input: { name?: string; avatarUrl?: string },
): Promise<Team | null> {
  const rows = await query<TeamRow>(
    `UPDATE teams
        SET name = COALESCE($2, name),
            avatar_url = COALESCE($3, avatar_url),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [teamId, input.name ?? null, input.avatarUrl ?? null],
  );
  return rows[0] ? mapTeam(rows[0]) : null;
}

/**
 * Deleting a team also unlinks its rides — no foreign keys here, so nothing else would, and
 * every ride would keep pointing at a team row that is gone.
 */
export async function deleteTeam(teamId: number): Promise<boolean> {
  return withTransaction(async (tx) => {
    await tx.query("UPDATE events SET team_id = NULL WHERE team_id = $1", [teamId]);
    await tx.query("DELETE FROM team_members WHERE team_id = $1", [teamId]);
    const rows = await tx.query<{ id: number }>("DELETE FROM teams WHERE id = $1 RETURNING id", [
      teamId,
    ]);
    return rows.length > 0;
  });
}

// ---- members -----------------------------------------------------------------------------

export async function selectMembersForTeam(teamId: number): Promise<TeamMember[]> {
  const rows = await query<TeamMemberRow>(
    `SELECT tm.*, ${MEMBER_DISPLAY_COLUMNS}
       FROM team_members tm
       LEFT JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1
      ORDER BY tm.created_at ASC`,
    [teamId],
  );
  return rows.map(mapMember);
}

export async function selectMemberById(
  memberId: number,
  teamId: number,
): Promise<TeamMember | null> {
  const row = await queryOne<TeamMemberRow>(
    `SELECT tm.*, ${MEMBER_DISPLAY_COLUMNS}
       FROM team_members tm
       LEFT JOIN users u ON u.id = tm.user_id
      WHERE tm.id = $1 AND tm.team_id = $2`,
    [memberId, teamId],
  );
  return row ? mapMember(row) : null;
}

export async function selectMemberByUser(
  teamId: number,
  userId: number,
): Promise<TeamMember | null> {
  const row = await queryOne<TeamMemberRow>(
    `SELECT tm.*, ${MEMBER_DISPLAY_COLUMNS}
       FROM team_members tm
       LEFT JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.user_id = $2`,
    [teamId, userId],
  );
  return row ? mapMember(row) : null;
}

export interface NewTeamMemberRow {
  userId: number | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: TeamMemberStatus;
}

/** All-or-nothing, same as the participant import: a file that fails on row 41 changes nothing. */
export async function insertTeamMembers(
  teamId: number,
  rows: NewTeamMemberRow[],
): Promise<TeamMember[]> {
  return withTransaction(async (tx) => {
    const created: TeamMember[] = [];
    for (const input of rows) {
      // The CTE re-joins `users` on the way out, exactly as the participant writes do: a
      // rider who asked to join has no name of their own, and the client renders this row.
      const row = await tx.queryOne<TeamMemberRow>(
        `WITH inserted AS (
           INSERT INTO team_members (team_id, user_id, name, email, phone, status)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *
         )
         SELECT tm.*, ${MEMBER_DISPLAY_COLUMNS}
           FROM inserted tm
           LEFT JOIN users u ON u.id = tm.user_id`,
        [teamId, input.userId, input.name, input.email, input.phone, input.status],
      );
      if (!row) throw new Error("insertTeamMembers returned no row");
      created.push(mapMember(row));
    }
    return created;
  });
}

export async function updateMemberStatus(
  memberId: number,
  teamId: number,
  status: TeamMemberStatus,
): Promise<TeamMember | null> {
  const rows = await query<TeamMemberRow>(
    `WITH updated AS (
       UPDATE team_members SET status = $3, updated_at = NOW()
        WHERE id = $1 AND team_id = $2
        RETURNING *
     )
     SELECT tm.*, ${MEMBER_DISPLAY_COLUMNS}
       FROM updated tm
       LEFT JOIN users u ON u.id = tm.user_id`,
    [memberId, teamId, status],
  );
  return rows[0] ? mapMember(rows[0]) : null;
}

export async function deleteMember(memberId: number, teamId: number): Promise<boolean> {
  return (await execute("DELETE FROM team_members WHERE id = $1 AND team_id = $2", [
    memberId,
    teamId,
  ])) > 0;
}

// ---- a team's schedule --------------------------------------------------------------------

export async function setEventTeam(eventId: string, teamId: number | null): Promise<void> {
  await execute("UPDATE events SET team_id = $2, updated_at = NOW() WHERE id = $1", [
    eventId,
    teamId,
  ]);
}

// ---- follows --------------------------------------------------------------------------------

export async function insertFollow(followerId: number, followeeId: number): Promise<void> {
  await execute(
    `INSERT INTO user_follows (follower_id, followee_id) VALUES ($1, $2)
      ON CONFLICT (follower_id, followee_id) DO NOTHING`,
    [followerId, followeeId],
  );
}

export async function deleteFollow(followerId: number, followeeId: number): Promise<boolean> {
  return (await execute(
    "DELETE FROM user_follows WHERE follower_id = $1 AND followee_id = $2",
    [followerId, followeeId],
  )) > 0;
}

export async function selectFollowingIds(followerId: number): Promise<number[]> {
  const rows = await query<{ followee_id: number }>(
    "SELECT followee_id FROM user_follows WHERE follower_id = $1",
    [followerId],
  );
  return rows.map((r) => r.followee_id);
}

export async function countFollowers(followeeId: number): Promise<number> {
  const row = await queryOne<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM user_follows WHERE followee_id = $1",
    [followeeId],
  );
  return Number(row?.count ?? 0);
}
