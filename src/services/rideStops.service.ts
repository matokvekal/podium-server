// RIDE STOP POINTS — break / coffee stops the ride's creator places on the map
// (sql/049-ride-stop-points.sql).
//
// Access is the ride's own authorization: getEventForViewer answers "does this ride exist for
// you" (404 if not), policy.ts "event:view_route" decides who may SEE the stops (same people who
// may see the route they sit on), and "event:manage_stops" decides who may change them — the
// ride's creator only.
//
// FAIL-SOFT READ: until sql/049 has run, the table does not exist (Postgres 42P01). A read then
// answers "no stops" instead of an error, so a server deployed ahead of its migration leaves
// every ride page exactly as it was. Writes are not softened — the creator gets a real error.

import { canEvent } from "../authz/policy.js";
import {
  RIDE_STOP_KINDS,
  RIDE_STOP_MAX_LABEL_LENGTH,
  RIDE_STOP_MAX_PER_RIDE,
  type RideStopKind,
} from "../config/ride-stops.js";
import { ApiError } from "../lib/api-error.js";
import {
  deleteRideStop as deleteRideStopRow,
  insertRideStop,
  type RideStopRow,
  selectRideStops,
  updateRideStop as updateRideStopRow,
} from "../queries/rideStops.queries.js";
import { canViewRoute, getEventForViewer } from "./event.service.js";

export interface RideStop {
  id: number;
  rideId: string;
  label: string;
  lat: number;
  lng: number;
  kind: RideStopKind;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface RideStopsLimits {
  maxStops: number;
  maxLabelLength: number;
}

export const RIDE_STOPS_LIMITS: RideStopsLimits = {
  maxStops: RIDE_STOP_MAX_PER_RIDE,
  maxLabelLength: RIDE_STOP_MAX_LABEL_LENGTH,
};

export interface RideStopsView {
  stops: RideStop[];
  /** Whether THIS caller may add / move / rename / delete — the client shows the controls
   * from this and never re-derives the rule. */
  canManage: boolean;
  limits: RideStopsLimits;
}

function toKind(value: string): RideStopKind {
  return (RIDE_STOP_KINDS as readonly string[]).includes(value)
    ? (value as RideStopKind)
    : "coffee";
}

export function toRideStop(row: RideStopRow): RideStop {
  return {
    id: Number(row.id),
    rideId: row.ride_id,
    label: row.label,
    lat: Number(row.lat),
    lng: Number(row.lng),
    kind: toKind(row.kind),
    sortOrder: Number(row.sort_order),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "42P01";
}

function cleanLabel(raw: string): string {
  const label = raw.trim().replace(/\s+/g, " ");
  if (!label) throw new ApiError(400, "Stop name is empty (RIDE_STOP_EMPTY_LABEL)");
  if (label.length > RIDE_STOP_MAX_LABEL_LENGTH) {
    throw new ApiError(
      400,
      `Stop name is longer than ${RIDE_STOP_MAX_LABEL_LENGTH} characters (RIDE_STOP_LABEL_TOO_LONG)`,
    );
  }
  return label;
}

/** 404 when the ride does not exist for the caller, 403 when it does but they did not create it
 * (or it is finished / cancelled). */
async function assertCanManage(rideId: string, userId: number): Promise<void> {
  const view = await getEventForViewer(rideId, userId);
  if (!canEvent(view.actor, "event:manage_stops", view.context)) {
    throw new ApiError(403, "Only the ride's creator can change its stops (RIDE_STOPS_NO_ACCESS)");
  }
}

/** The stops of a ride, for anyone who may see its route. Viewer may be signed out. */
export async function listRideStops(rideId: string, viewerId: number | null): Promise<RideStopsView> {
  const view = await getEventForViewer(rideId, viewerId);
  const canManage = canEvent(view.actor, "event:manage_stops", view.context);
  if (!canViewRoute(view)) return { stops: [], canManage, limits: RIDE_STOPS_LIMITS };

  let rows: RideStopRow[];
  try {
    rows = await selectRideStops(rideId);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    // sql/049 not run yet: behave as "no stops", and don't offer an editor that cannot save.
    return { stops: [], canManage: false, limits: RIDE_STOPS_LIMITS };
  }
  return { stops: rows.map(toRideStop), canManage, limits: RIDE_STOPS_LIMITS };
}

export async function addRideStop(
  rideId: string,
  userId: number,
  input: { label: string; lat: number; lng: number; kind?: RideStopKind },
): Promise<RideStop> {
  const label = cleanLabel(input.label);
  await assertCanManage(rideId, userId);

  const result = await insertRideStop(
    rideId,
    userId,
    { label, lat: input.lat, lng: input.lng, kind: input.kind ?? "coffee" },
    RIDE_STOP_MAX_PER_RIDE,
  );
  if (result.kind === "limit") {
    throw new ApiError(
      409,
      `This ride already has ${RIDE_STOP_MAX_PER_RIDE} stops (RIDE_STOPS_LIMIT)`,
    );
  }
  return toRideStop(result.row);
}

export async function editRideStop(
  rideId: string,
  stopId: number,
  userId: number,
  patch: { label?: string; lat?: number; lng?: number; kind?: RideStopKind; sortOrder?: number },
): Promise<RideStop> {
  const clean = { ...patch, label: patch.label === undefined ? undefined : cleanLabel(patch.label) };
  await assertCanManage(rideId, userId);

  const row = await updateRideStopRow(rideId, stopId, clean);
  if (!row) throw new ApiError(404, "Stop not found");
  return toRideStop(row);
}

export async function removeRideStop(rideId: string, stopId: number, userId: number): Promise<void> {
  await assertCanManage(rideId, userId);
  const deleted = await deleteRideStopRow(rideId, stopId);
  if (!deleted) throw new ApiError(404, "Stop not found");
}
