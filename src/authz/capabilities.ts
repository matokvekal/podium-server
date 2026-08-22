// The capability catalogue — the contract between server and client.
//
// The server computes which of these a caller has and sends the list; the client renders from
// it and never re-derives a rule. If the server sent roles and plans instead, the client would
// have to reimplement authorization to decide what to show, and would drift the first time a
// rule changed.
//
// These strings are a published interface. Renaming one is a breaking change for the client.

/** Capabilities that need no resource — "may this person do this at all, right now". */
export const ACCOUNT_CAPABILITIES = [
  "event:create",
  /** Create a ride that is not public. Separate from event:create because it is sellable. */
  "event:create_private",
  "team:create",
  "route:create",
  "route:publish",
] as const;

/** Capabilities evaluated against one event, for one caller. */
export const EVENT_CAPABILITIES = [
  /** The ride exists for you at all. Without this the answer is 404, never 403. */
  "event:view",
  /** When and where: startsAt, endsAt, location, description. */
  "event:view_details",
  "event:view_route",
  "event:view_participants",
  "event:view_live",
  "event:view_results",
  "event:view_history",
  "event:join",
  "event:edit",
  "event:change_status",
  "event:delete",
  "event:manage_participants",
  "event:manage_groups",
  "event:manage_route",
  /** Add or remove co-organizers. The Club tier's "multiple admins". */
  "event:manage_members",
] as const;

export const TEAM_CAPABILITIES = [
  "team:view",
  "team:manage",
  "team:manage_members",
  "team:join",
] as const;

export type AccountCapability = (typeof ACCOUNT_CAPABILITIES)[number];
export type EventCapability = (typeof EVENT_CAPABILITIES)[number];
export type TeamCapability = (typeof TEAM_CAPABILITIES)[number];
export type Capability = AccountCapability | EventCapability | TeamCapability;

/**
 * Features a plan may grant. Distinct from capabilities: a feature is something a plan
 * *contains*, a capability is something a caller *may do right now*. `private_events` is a
 * feature; `event:create_private` is the capability it unlocks, and the two are separate
 * because the capability also depends on being signed in and on a one-time purchase having
 * been made, neither of which is a plan.
 */
export const FEATURES = [
  "private_events",
  /** Co-organizers on an event — event_members.role = 'operator'. */
  "co_organizers",
  /** Reserved: splits, category scoring, exports. Nothing reads it yet. */
  "advanced_results",
] as const;
export type Feature = (typeof FEATURES)[number];
