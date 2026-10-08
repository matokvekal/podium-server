// Ride MANAGERS — people the ride's creator names by email to run the ride with them.
//
// A manager is an event_members row with role = 'operator'. policy.ts treats an operator as
// staff, so a manager may do everything the creator does — edit, route, riders, groups, stops,
// cancel — except "event:manage_members": only the creator appoints or removes managers.
//
// An email with no account yet is kept in event_manager_invites (sql/059) and claimed by the
// first Google sign-in with that (verified) email — see claimManagerInvites, called from
// auth.service.ts. Nothing here sends email; the creator tells the person themselves.
//
// FAIL-SOFT on a database without sql/059 (42P01): the list shows no pending invites and the
// sign-in claim does nothing. Only inviting an unknown email needs the table.

import { canEvent } from "../authz/policy.js";
import { ApiError } from "../lib/api-error.js";
import { logger } from "../lib/logger.js";
import {
  claimManagerInvitesForEmail,
  deleteEventManager,
  deleteManagerInvite,
  insertEventManager,
  insertManagerInvite,
  type ManagerInviteRow,
  selectEventManagers,
  selectManagerInvites,
  selectUserIdByEmail,
} from "../queries/eventManagers.queries.js";
import { selectUserById } from "../queries/user.queries.js";
import { type EventView, getEventForViewer } from "./event.service.js";

export interface EventManager {
  userId: number;
  name: string | null;
  email: string | null;
}

export interface EventManagersView {
  /** The ride's creator. Not removable, not listed again under `managers`. */
  owner: { userId: number; name: string | null } | null;
  managers: EventManager[];
  /** Emails waiting for their first sign-in. */
  pending: { email: string; createdAt: string }[];
  /** Whether THIS caller may add / remove — the creator only. */
  canManage: boolean;
}

export type AddManagerResult = { status: "added"; manager: EventManager } | { status: "invited" };

function isMissingTable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "42P01";
}

function displayName(row: {
  firstName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
}): string | null {
  return [row.firstName, row.lastName].filter(Boolean).join(" ").trim() || row.nickname || null;
}

function isOrganizer(view: EventView): boolean {
  return view.context.role === "owner" || view.context.role === "operator";
}

async function assertMayManageMembers(eventId: string, userId: number): Promise<EventView> {
  const view = await getEventForViewer(eventId, userId);
  if (!canEvent(view.actor, "event:manage_members", view.context)) {
    throw new ApiError(403, "Only the ride's creator can change its managers");
  }
  return view;
}

/** The managers of a ride, for its organizers (creator and managers). */
export async function listEventManagers(
  eventId: string,
  userId: number,
): Promise<EventManagersView> {
  const view = await getEventForViewer(eventId, userId);
  if (!isOrganizer(view)) {
    throw new ApiError(403, "Only the ride's organizers can see its managers");
  }

  let invites: ManagerInviteRow[] = [];
  try {
    invites = await selectManagerInvites(eventId);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  const [owner, managers] = await Promise.all([
    view.event.ownerId === null ? Promise.resolve(null) : selectUserById(view.event.ownerId),
    selectEventManagers(eventId),
  ]);

  return {
    owner: owner ? { userId: owner.id, name: displayName(owner) } : null,
    managers: managers.map((row) => ({
      userId: row.user_id,
      name: displayName({
        firstName: row.first_name,
        lastName: row.last_name,
        nickname: row.nickname,
      }),
      email: row.email,
    })),
    pending: invites.map((row) => ({
      email: row.email,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    canManage: canEvent(view.actor, "event:manage_members", view.context),
  };
}

/**
 * Adds a manager by email. An existing account becomes an operator now; an unknown email is
 * kept until its first sign-in. `email` is already trimmed and lower-cased by the schema.
 */
export async function addEventManager(
  eventId: string,
  userId: number,
  email: string,
): Promise<AddManagerResult> {
  const view = await assertMayManageMembers(eventId, userId);

  const targetId = await selectUserIdByEmail(email);
  if (targetId === null) {
    await insertManagerInvite(eventId, email, userId);
    logger.info({ eventId, userId }, "ride manager invited by email");
    return { status: "invited" };
  }

  if (targetId === view.event.ownerId) {
    throw new ApiError(400, "That is the ride's creator — they already manage it");
  }
  await insertEventManager(eventId, targetId);
  logger.info({ eventId, userId, managerId: targetId }, "ride manager added");

  const user = await selectUserById(targetId);
  return {
    status: "added",
    manager: { userId: targetId, name: user ? displayName(user) : null, email },
  };
}

export async function removeEventManager(
  eventId: string,
  userId: number,
  managerId: number,
): Promise<void> {
  await assertMayManageMembers(eventId, userId);
  const removed = await deleteEventManager(eventId, managerId);
  if (!removed) throw new ApiError(404, "Manager not found");
  logger.info({ eventId, userId, managerId }, "ride manager removed");
}

export async function removeManagerInvite(
  eventId: string,
  userId: number,
  email: string,
): Promise<void> {
  await assertMayManageMembers(eventId, userId);
  const removed = await deleteManagerInvite(eventId, email);
  if (!removed) throw new ApiError(404, "Invite not found");
}

/**
 * Sign-in hook: every ride that invited this (verified) email now has this user as a manager.
 * Never throws — a failure here must not fail the sign-in that called it.
 */
export async function claimManagerInvites(userId: number, email: string | null): Promise<void> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return;
  try {
    const claimed = await claimManagerInvitesForEmail(userId, normalized);
    if (claimed.length > 0) {
      logger.info({ userId, eventIds: claimed }, "ride manager invites claimed");
    }
  } catch (err) {
    if (isMissingTable(err)) return;
    logger.warn({ err, userId }, "could not claim ride manager invites");
  }
}
