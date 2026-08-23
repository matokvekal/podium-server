import { z } from "zod";
import { TEAM_MEMBER_STATUSES } from "../db/types.js";

export const teamIdParamSchema = z.object({
  teamId: z.coerce.number().int().positive(),
});

export const teamMemberParamSchema = z.object({
  teamId: z.coerce.number().int().positive(),
  memberId: z.coerce.number().int().positive(),
});

export const createTeamSchema = z.object({
  name: z.string().min(1).max(200),
  avatarUrl: z.string().url().max(500).optional(),
});

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  avatarUrl: z.string().url().max(500).optional(),
});

const teamMemberInput = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(100).optional(),
});

/**
 * Always an array, even for one member. The four add methods on the client's team screen
 * (by hand, from a file, from phone contacts, WhatsApp invite) are one code path this way,
 * and a contacts import of 40 people is one request.
 */
export const addTeamMembersSchema = z.object({
  members: z.array(teamMemberInput).min(1).max(500),
});

export const setMemberStatusSchema = z.object({
  status: z.enum(TEAM_MEMBER_STATUSES),
});

/** null unlinks the ride from every team without deleting anything. */
export const linkEventTeamSchema = z.object({
  teamId: z.number().int().positive().nullable(),
});

export const followParamSchema = z.object({
  userId: z.coerce.number().int().positive(),
});
