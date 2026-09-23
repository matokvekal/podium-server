// Ride chat limits (sql/047-ride-chat.sql). Plain constants on purpose — V1 values the product
// asked for, kept in one place so changing one is a one-line edit and no migration.

/** Characters in one message, after trimming. */
export const RIDE_CHAT_MAX_MESSAGE_LENGTH = 500;

/** Messages one ride's chat may hold in total. */
export const RIDE_CHAT_MAX_MESSAGES_PER_RIDE = 500;

/** Rides one unread-summary request may ask about (the rider's ride list, one request). */
export const RIDE_CHAT_MAX_SUMMARY_RIDES = 100;

/** Unread counts stop counting here; the client shows "99+". Keeps the count query bounded. */
export const RIDE_CHAT_UNREAD_CAP = 100;

/** Sends per rider per minute — a small guard against a stuck retry loop, not moderation. */
export const RIDE_CHAT_SENDS_PER_MINUTE = 20;
