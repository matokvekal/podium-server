// Ride stop point limits (sql/049-ride-stop-points.sql). Plain constants on purpose, same as
// config/ride-chat.ts — changing one is a one-line edit and no migration.

/** Stops one ride may have. The client reads this from GET /events/:eventId/stops. */
export const RIDE_STOP_MAX_PER_RIDE = 5;

/** Characters in a stop's label, after trimming. */
export const RIDE_STOP_MAX_LABEL_LENGTH = 120;

/** The icon choices. The first is the default. */
export const RIDE_STOP_KINDS = ["coffee", "water", "food", "regroup", "other"] as const;
export type RideStopKind = (typeof RIDE_STOP_KINDS)[number];
