import { z } from "zod";
import {
  ACTIVITY_TYPES,
  DISPLAY_MODES,
  EVENT_STATUSES,
  EVENT_TYPES,
  EVENT_VISIBILITIES,
  RIDER_LEVELS,
} from "../db/types.js";

export const eventCodeParamSchema = z.object({
  code: z.string().min(1).max(32),
});

export const eventIdParamSchema = z.object({
  eventId: z.string().uuid(),
});

export const createEventSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(EVENT_TYPES).optional().default("RIDE"),

  // There is no draft workflow in this product: the create form is one screen of mandatory
  // fields, so an event is complete the moment it is POSTed. Defaulting to "published" is what
  // makes the ride's code resolve straight away (is_active is false for a draft), and removes
  // the create-then-PATCH-status round trip the client used to need. `draft` stays available
  // for a caller that explicitly wants to stage one, and stays in the transition graph so the
  // manual Publish step remains the escape hatch for an event that somehow lands there.
  //
  // Only these two: creating directly into `live` would skip the concurrent-live entitlement
  // check that only changeEventStatus performs.
  status: z.enum(["draft", "published"]).optional().default("published"),

  requiresBib: z.boolean().optional().default(false),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  displayMode: z.enum(DISPLAY_MODES).optional().default("standard"),
  visibility: z.enum(EVENT_VISIBILITIES).optional().default("private"),
  description: z.string().max(4000).optional(),
  location: z.string().max(255).optional(),
  area: z.string().max(255).optional(),
  requiresApproval: z.boolean().optional().default(false),

  // "I'm riding too" on the create form. The organizer is on event_members as owner either
  // way; this is the separate question of whether they are also ON THE START LIST, and it
  // is the only way to put them there as themselves. Without it the client's only option
  // was the manual-add endpoint, which writes user_id NULL — an anonymous rider row that no
  // client can match against the signed-in user. Optional and defaulting to false, so an
  // organizer who is not riding, and every existing caller, are unaffected.
  joinAsRider: z.boolean().optional().default(false),

  // The create form collects these too — "riders can see the list" in particular. Left off
  // this schema they were stripped silently (zod objects drop unknown keys), so the organizer's
  // choice was lost until they happened to open Edit. Optional, not defaulted: undefined means
  // "use the column default" rather than "set it to false".
  showEventInfo: z.boolean().optional(),
  showParticipants: z.boolean().optional(),
  showRoute: z.boolean().optional(),
  showLiveLocations: z.boolean().optional(),
  showHistoryLocations: z.boolean().optional(),
  showResults: z.boolean().optional(),

  // Collected by the create form all along; the server had nowhere to put them until
  // sql/010-event-profile.sql.
  activityType: z.enum(ACTIVITY_TYPES).optional(),
  level: z.enum(RIDER_LEVELS).optional(),
  organizerGroup: z.string().max(200).optional(),

  // The organizer's elevation-gain value (metres). Imported from a GPX by the client, or typed
  // by hand — either way this is the number they chose to publish. `null` clears it (fall back
  // to the attached route's climb). Omitted = leave the stored value alone. Stored in
  // events.elevation_gain_m; see sql/021-events-elevation-gain.sql.
  elevationGainM: z.number().nonnegative().max(100000).nullable().optional(),

  // Organizer-set ride plan — see sql/022-event-ride-plan.sql. All three: `null` (or omitted)
  // means "not stated / leave alone", a value sets it. duration in whole minutes.
  durationMin: z.number().int().positive().max(2880).nullable().optional(),
  restStops: z.number().int().min(0).max(20).nullable().optional(),
  isAccessible: z.boolean().optional(),

  // The organizer states a support / sag vehicle follows the ride — see
  // sql/024-event-support-vehicle.sql. Omitted means "not set", which the column stores as
  // false. Never nullable: unlike duration there is no third state worth keeping.
  hasSupportVehicle: z.boolean().optional(),

  // How many riders the organizer expects — see sql/028-events-expected-participants.sql. `null`
  // (or omitted) means "not stated"; a positive number sets it. NOT a capacity — the plan limit
  // is the real ceiling and is never sent to viewers.
  expectedParticipants: z.number().int().positive().max(100000).nullable().optional(),
});

export const updateEventSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.enum(EVENT_TYPES).optional(),
  requiresBib: z.boolean().optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  displayMode: z.enum(DISPLAY_MODES).optional(),
  visibility: z.enum(EVENT_VISIBILITIES).optional(),
  description: z.string().max(4000).optional(),
  location: z.string().max(255).optional(),
  area: z.string().max(255).optional(),
  showEventInfo: z.boolean().optional(),
  showParticipants: z.boolean().optional(),
  showRoute: z.boolean().optional(),
  showLiveLocations: z.boolean().optional(),
  showHistoryLocations: z.boolean().optional(),
  showResults: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  activityType: z.enum(ACTIVITY_TYPES).optional(),
  level: z.enum(RIDER_LEVELS).optional(),
  organizerGroup: z.string().max(200).optional(),

  // See createEventSchema. `null` clears the organizer's value; omitted leaves it untouched.
  elevationGainM: z.number().nonnegative().max(100000).nullable().optional(),

  // See createEventSchema. `null` clears the field; omitted leaves it untouched.
  durationMin: z.number().int().positive().max(2880).nullable().optional(),
  restStops: z.number().int().min(0).max(20).nullable().optional(),
  isAccessible: z.boolean().optional(),

  // See createEventSchema. Omitted leaves it untouched; false turns the badge off again.
  hasSupportVehicle: z.boolean().optional(),

  // See createEventSchema. `null` clears it; omitted leaves it untouched.
  expectedParticipants: z.number().int().positive().max(100000).nullable().optional(),
});

export const changeEventStatusSchema = z.object({
  status: z.enum(EVENT_STATUSES),
});

export const pauseEventSchema = z.object({
  paused: z.boolean(),
});

/** ?riders=1,2,3 on GET /:eventId/live — invalid/non-positive ids are dropped rather than 400ing. */
export const liveQuerySchema = z.object({
  riders: z
    .string()
    .optional()
    .transform((value): number[] | null => {
      if (!value) return null;
      return value
        .split(",")
        .map((part) => Number(part))
        .filter((n) => Number.isInteger(n) && n > 0);
    }),
});

export const listEventsQuerySchema = z.object({
  filter: z
    .enum(["mine", "joined", "upcoming", "live", "past", "following"])
    .optional()
    .default("mine"),
});

/** The ride-duration filter offers ranges, not a free number — see the client's DURATION_BUCKETS
 *  and selectPublicEvents' OR-group. Whole hours, matched against events.duration_min. */
export const DURATION_BUCKET_KEYS = ["lt1", "1to2", "2to3", "3to5", "gt5"] as const;
export type DurationBucketKey = (typeof DURATION_BUCKET_KEYS)[number];

/**
 * A comma-separated list of enum values → a de-duplicated array, dropping anything not in the
 * vocabulary rather than 400ing (a stale filter chip in a saved URL must not break the list).
 * `undefined` when the param is absent or nothing valid survived, so the query treats it as
 * "no filter". A bare single value (what "Find Rides" sends) still parses to a one-element list.
 */
function csvEnum<const T extends readonly string[]>(allowed: T) {
  const set = new Set<string>(allowed);
  return z
    .string()
    .max(200)
    .optional()
    .transform((raw): T[number][] | undefined => {
      if (!raw) return undefined;
      const picked = raw
        .split(",")
        .map((part) => part.trim())
        .filter((part): part is T[number] => set.has(part));
      return picked.length > 0 ? [...new Set(picked)] : undefined;
    });
}

/** Like csvEnum but for a free-text list (areas) — trims, drops blanks, de-dupes, caps length. */
function csvStrings(maxLen: number) {
  return z
    .string()
    .max(maxLen)
    .optional()
    .transform((raw): string[] | undefined => {
      if (!raw) return undefined;
      const picked = raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.slice(0, 200));
      return picked.length > 0 ? [...new Set(picked)] : undefined;
    });
}

/**
 * The public "Find Rides" browser and the event-create "Browse tracks" picker. Every one of
 * these used to run in the client's memory over whatever the first 20 rows happened to be — so
 * a "Finished" filter could render empty while finished rides sat at row 21. Doing it here is
 * the only way the answer can be right, and the only way the "Browse tracks" picker scales past
 * a few hundred rides.
 *
 * `bucket` is the Live / Upcoming / Finished pill, expressed as the question a rider is
 * actually asking rather than as a raw status: "upcoming" spans three statuses, and "finished"
 * has to include a ride whose end time has passed but whose status nobody flipped.
 *
 * `activityType` / `level` accept a comma list for the picker's multi-select, but a single
 * value (the Find Rides pill) is just a one-element list. The distance / climb / duration
 * filters are the picker's — Find Rides never sends them.
 */
export const publicEventsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  type: z.enum(EVENT_TYPES).optional(),
  bucket: z.enum(["live", "upcoming", "finished"]).optional(),
  activityType: csvEnum(ACTIVITY_TYPES),
  level: csvEnum(RIDER_LEVELS),
  /** Exact match against one or more values from GET /events/public/areas. */
  areas: csvStrings(400),
  /** The attached route's distance, km. */
  minDistanceKm: z.coerce.number().nonnegative().max(100000).optional(),
  maxDistanceKm: z.coerce.number().nonnegative().max(100000).optional(),
  /** EFFECTIVE climb: the organizer's elevation_gain_m, else the attached route's, metres. */
  minClimbM: z.coerce.number().nonnegative().max(100000).optional(),
  maxClimbM: z.coerce.number().nonnegative().max(100000).optional(),
  durationBuckets: csvEnum(DURATION_BUCKET_KEYS),
  /** Default depends on the bucket — see listPublicEvents. The distance/elevation/duration
   *  orders sink a NULL metric to the bottom and tie-break on created_at DESC, id. */
  sort: z
    .enum([
      "soonest",
      "latest",
      "newest",
      "oldest",
      "distance_asc",
      "distance_desc",
      "elevation_asc",
      "elevation_desc",
      "duration_asc",
      "duration_desc",
      "name_asc",
    ])
    .optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

export const joinEventSchema = z.object({
  eventCode: z.string().min(1).max(32),
  bib: z.string().min(1).max(16).optional(),
});

export const locationPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
  recordedAt: z.coerce.date(),
  emergency: z.boolean().optional().default(false),
});

export const locationBatchSchema = z.object({
  participantId: z.number().int().positive(),
  points: z.array(locationPointSchema).min(1).max(200),
});
