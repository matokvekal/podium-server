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

/**
 * The public "Find Rides" browser. Every one of these used to run in the client's memory over
 * whatever the first 20 rows happened to be — so a "Finished" filter could render empty while
 * finished rides sat at row 21. Doing it here is the only way the answer can be right.
 *
 * `bucket` is the Live / Upcoming / Finished pill, expressed as the question a rider is
 * actually asking rather than as a raw status: "upcoming" spans three statuses, and "finished"
 * has to include a ride whose end time has passed but whose status nobody flipped.
 */
export const publicEventsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  type: z.enum(EVENT_TYPES).optional(),
  bucket: z.enum(["live", "upcoming", "finished"]).optional(),
  activityType: z.enum(ACTIVITY_TYPES).optional(),
  level: z.enum(RIDER_LEVELS).optional(),
  /** Default depends on the bucket — see listPublicEvents. */
  sort: z.enum(["soonest", "latest", "newest"]).optional(),
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
