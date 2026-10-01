// routes.ai_search_text (sql/057) — the plain-text "what is this track" blob that free-text track
// search will read. Pure functions only: what goes in, how it is labelled, and how a new ride's
// details are merged into what a route already has. The SQL that reads and writes it is in
// queries/routeSearch.queries.ts; the one-off fill is scripts/backfillRouteSearchText.ts.
//
// SEARCH KNOWLEDGE BELONGS TO THE ROUTE. A route is shared by every ride built on it, so each
// ride adds what it says about the TRACK (where, what surface, how hard, when, how shaded) — not
// about the day (date, participants, start time). No AI and nothing inferred: every line is a
// value an organizer typed or picked.
//
// FORMAT. One `Label: value` per line, in the order rides were processed. Labels keep the text
// readable to a person and to whatever reads it later; values are what search actually matches.
//
// DEDUPLICATION is on the VALUE, as a whole word/phrase, case- and spacing-insensitive: a value
// already present anywhere in the text (under any label, or inside a longer value) is not added
// again. Ten rides on one track with the same region, season and surface add those lines once.
//
// PRIVACY. Only a ride that is itself publicly listed may contribute (isEventEligibleForRouteText)
// — the same rule GET /events/public uses. A private ride's description must never become
// searchable through a public track it happens to reuse.

import { IL_REGIONS } from "./regions.js";

/** Stored in routes.ai_search_version. Bump when the format or the field list changes, so a
 *  later rebuild can find rows written by an older recipe. */
export const AI_SEARCH_TEXT_VERSION = 1;

/** One field's cap — a pasted essay of a description should not crowd out everything else. */
export const MAX_FRAGMENT_CHARS = 1000;
/** The whole blob's cap. Once reached, later rides add nothing (they are still marked processed). */
export const MAX_SEARCH_TEXT_CHARS = 8000;

/** The routes columns that describe the track itself. */
export interface RouteSearchSource {
  name: string | null;
  place_name: string | null;
  route_type: string | null;
}

/** The events columns that describe the TRACK a ride uses (not the ride's day or people). */
export interface EventSearchSource {
  name: string | null;
  description: string | null;
  location: string | null;
  area: string | null;
  region: string | null;
  country: string | null;
  activity_type: string | null;
  level: string | null;
  route_difficulty: string | null;
  season: string | null;
  shade: string | null;
  terrain_grade: number | null;
  is_accessible: boolean | null;
}

export interface SearchFragment {
  label: string;
  value: string;
}

const ACTIVITY_LABEL: Record<string, string> = {
  road: "road cycling",
  mtb: "mountain bike (MTB)",
  gravel: "gravel",
  running: "running",
  hiking: "hiking",
};

const ROUTE_TYPE_LABEL: Record<string, string> = {
  road: "road",
  gravel: "gravel",
  mtb: "mountain bike (MTB)",
  mixed: "mixed surface",
};

const SEASON_LABEL: Record<string, string> = {
  all_year: "all year",
  all_year_summer_ok: "all year, fine in summer",
  winter_spring: "winter and spring",
  spring_autumn: "spring and autumn",
};

const SHADE_LABEL: Record<string, string> = {
  shaded: "shaded",
  partial: "partly shaded",
  exposed: "exposed, little shade",
};

/** A stored enum value for which no label is defined yet still reads as words. */
function words(value: string): string {
  return value.replace(/_/g, " ");
}

/** One line: whitespace collapsed (a multi-line description becomes one line), trimmed, capped. */
function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > MAX_FRAGMENT_CHARS
    ? `${flat.slice(0, MAX_FRAGMENT_CHARS).trimEnd()}…`
    : flat;
}

function push(out: SearchFragment[], label: string, value: string | null | undefined): void {
  const v = clean(value);
  if (v) out.push({ label, value: v });
}

/** "Center / מרכז" for a known key — both languages, so a search in either finds it. */
function regionText(key: string): string {
  const region = IL_REGIONS.find((r) => r.key === key);
  return region ? `${region.en} / ${region.he}` : words(key);
}

/** S1..S5 for MTB and G1..G5 for gravel (sql/038), a plain number for anything else. */
function terrainText(grade: number, activityType: string | null): string {
  if (activityType === "mtb") return `S${grade}`;
  if (activityType === "gravel") return `G${grade}`;
  return String(grade);
}

export function routeFragments(route: RouteSearchSource): SearchFragment[] {
  const out: SearchFragment[] = [];
  push(out, "Track", route.name);
  push(out, "Place", route.place_name);
  if (route.route_type) {
    push(out, "Surface", ROUTE_TYPE_LABEL[route.route_type] ?? words(route.route_type));
  }
  return out;
}

export function eventFragments(event: EventSearchSource): SearchFragment[] {
  const out: SearchFragment[] = [];
  push(out, "Ride", event.name);
  push(out, "Location", event.location);
  push(out, "Area", event.area);
  if (event.region) push(out, "Region", regionText(event.region));
  push(out, "Country", event.country);
  if (event.activity_type) {
    push(out, "Activity", ACTIVITY_LABEL[event.activity_type] ?? words(event.activity_type));
  }
  if (event.route_difficulty) push(out, "Difficulty", words(event.route_difficulty));
  if (event.level) push(out, "Rider level", words(event.level));
  if (event.terrain_grade !== null && event.terrain_grade !== undefined) {
    push(out, "Terrain grade", terrainText(event.terrain_grade, event.activity_type));
  }
  if (event.season) push(out, "Season", SEASON_LABEL[event.season] ?? words(event.season));
  if (event.shade) push(out, "Shade", SHADE_LABEL[event.shade] ?? words(event.shade));
  if (event.is_accessible) push(out, "Accessibility", "accessible");
  // Last: the longest and least structured, so a cap trims it rather than a region or season.
  push(out, "Description", event.description);
  return out;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word/phrase containment, Unicode-aware (Hebrew included): "S2" is not found inside
 *  "S25", and "Modiin" is found inside "Modiin forest loop". */
function containsPhrase(haystack: string, needle: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}])`, "u").test(
    haystack,
  );
}

/**
 * Appends every fragment whose value is not already in `existing`. Returns the new text, or
 * null when nothing was added — the caller then leaves the route row untouched.
 */
export function mergeSearchText(
  existing: string | null,
  fragments: readonly SearchFragment[],
): string | null {
  const lines = existing ? existing.split("\n").filter((l) => l.trim() !== "") : [];
  let haystack = normalize(lines.join("\n"));
  let length = lines.join("\n").length;
  let added = false;

  for (const { label, value } of fragments) {
    const needle = normalize(value);
    if (!needle || containsPhrase(haystack, needle)) continue;
    const line = `${label}: ${value}`;
    const nextLength = length + (lines.length > 0 ? 1 : 0) + line.length;
    if (nextLength > MAX_SEARCH_TEXT_CHARS) continue;
    lines.push(line);
    haystack = `${haystack}\n${normalize(line)}`;
    length = nextLength;
    added = true;
  }
  return added ? lines.join("\n") : null;
}

/** May this ride's details become searchable on its track? Same rule as GET /events/public. */
export function isEventEligibleForRouteText(event: {
  visibility: string;
  status: string;
}): boolean {
  return event.visibility === "public" && event.status !== "draft" && event.status !== "cancelled";
}
