// metadata.json -> the El Nino event/route model, for the curated MTB import.
//
// Every value set below is exactly what the 1009 curated files contain (checked, not assumed).
// A value NOT in the tables is an ERROR for that one track — never silently NULLed and never
// guessed — so a new spelling shows up in the dry-run instead of vanishing into a column.

import type { RouteDifficulty, TrailSeason, TrailShade } from "../../db/types.js";
import { classifyRegion, IL_REGIONS, isRegionKey } from "../regions.js";

/** Whitespace-, dash- and slash-spacing-insensitive key, so "כרמל / רמות מנשה" and
 *  "כרמל/רמות  מנשה" are one area rather than two. NFC so composed/decomposed forms match. */
export function normalizeKey(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

const DIFFICULTY: Record<string, RouteDifficulty> = {
  קל: "easy",
  בינוני: "moderate",
  קשה: "hard",
  אתגרי: "challenging",
};

const SEASON: Record<string, TrailSeason> = {
  "כל השנה": "all_year",
  "כל השנה (נעים בקיץ)": "all_year_summer_ok",
  "חורף-אביב": "winter_spring",
  // The observed value is אביב–סתיו (spring THROUGH autumn — the warm half of the year). It is
  // NOT סתיו–אביב (autumn through spring), so the key says spring_autumn.
  "אביב-סתיו": "spring_autumn",
};

const SHADE: Record<string, TrailShade> = {
  מוצל: "shaded",
  "חלקית מוצל": "partial",
  "חשוף לשמש": "exposed",
};

/** The curated `area` -> the stable events.region key. events.area keeps the specific Hebrew
 *  label, so the three Negev spellings share `negev` without losing what the file said. */
const AREA_REGION: Record<string, string> = {
  "ירושלים והרים": "jerusalem",
  "שפלת יהודה": "shfela",
  "מרכז/שפלה": "center",
  שרון: "sharon",
  "ערבה/אילת": "arava",
  "מדבר יהודה ובקעת ים המלח": "dead_sea",
  "רמת הגולן": "golan",
  "גליל עליון": "upper_galilee",
  "גליל תחתון": "lower_galilee",
  "גליל מערבי": "western_galilee",
  "כרמל/רמות מנשה": "carmel",
  "גלבוע ועמקים": "gilboa_valleys",
  "דרום הר חברון": "south_hebron",
  "נגב מערבי": "negev",
  "נגב/מכתשים": "negev",
  "נגב צפוני": "negev",
};

export interface MtbTrackMetadata {
  name: string;
  description: string | null;
  country: string;
  /** Straight from metadata (km). */
  distanceKm: number;
  /** Curated climb, metres. null when the file has none OR its value is invalid (negative) — the
   *  planner then derives it from the GPX elevation, or leaves it unknown. Never negative. */
  climbM: number | null;
  /** The file HAD a climb_m but it was negative, i.e. invalid metadata. */
  climbInvalid: boolean;
  /** The file's own coordinates, for validating the area against. null when absent. */
  latitude: number | null;
  longitude: number | null;
  /** 'area' = mapped from the curated area (normal); 'coordinates' = the area was missing or
   *  unknown and the region was derived from the coordinates instead (a review item). */
  regionSource: "area" | "coordinates";
  /** duration_hours converted to minutes (events.duration_min). null when none. */
  durationMin: number | null;
  routeDifficulty: RouteDifficulty;
  season: TrailSeason;
  shade: TrailShade;
  /** events.region — the stable key. */
  region: string;
  /** events.area — the Hebrew display label, whitespace-normalized, otherwise as curated. */
  area: string;
}

export type MetadataResult =
  | { ok: true; value: MtbTrackMetadata; warnings: string[] }
  | { ok: false; errors: string[] };

/** Number, or a numeric string ("51") — the three uncurated files carry strings. Anything else
 *  (empty, NaN, null) is `null`, never 0. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

const NAME_MAX = 255;
const DESCRIPTION_MAX = 4000;

export function normalizeMtbMetadata(raw: unknown): MetadataResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["metadata.json is not an object"] };
  }
  const m = raw as Record<string, unknown>;

  const name = typeof m.name === "string" ? m.name.normalize("NFC").trim() : "";
  if (!name) errors.push("name is empty");
  else if (name.length > NAME_MAX) errors.push(`name is ${name.length} chars (max ${NAME_MAX})`);

  let description: string | null = null;
  if (typeof m.description === "string" && m.description.trim()) {
    description = m.description.trim();
    if (description.length > DESCRIPTION_MAX) {
      errors.push(`description is ${description.length} chars (max ${DESCRIPTION_MAX})`);
    }
  }

  const country = typeof m.country === "string" ? m.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(country)) errors.push(`country "${String(m.country)}" is not 2 letters`);

  const distanceKm = toNumber(m.distance_km);
  if (distanceKm === null || distanceKm <= 0) errors.push(`distance_km "${String(m.distance_km)}"`);

  // A negative climb is invalid metadata (it looks like end-minus-start elevation), not a reason to
  // lose the track: it is treated as unknown here and the planner recomputes it from the GPX.
  const rawClimb = toNumber(m.climb_m);
  const climbInvalid = rawClimb !== null && rawClimb < 0;
  const climbM = rawClimb !== null && rawClimb >= 0 ? rawClimb : null;
  if (climbInvalid) warnings.push(`climb_m ${rawClimb} is negative (invalid) — recomputing from GPX`);
  else if (rawClimb === null) warnings.push("no climb_m");

  const latitude = toNumber(m.latitude);
  const longitude = toNumber(m.longitude);

  const hours = toNumber(m.duration_hours);
  let durationMin: number | null = null;
  if (hours === null) warnings.push("no duration_hours");
  else if (hours <= 0) errors.push(`duration_hours ${hours} is not positive`);
  else durationMin = Math.max(1, Math.round(hours * 60));

  const pick = <T>(table: Record<string, T>, field: string): T | null => {
    const value = m[field];
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${field} is missing`);
      return null;
    }
    const found = table[normalizeKey(value)];
    if (found === undefined) errors.push(`${field} "${value}" is not a known value`);
    return found ?? null;
  };
  const routeDifficulty = pick(DIFFICULTY, "difficulty");
  const season = pick(SEASON, "season");
  const shade = pick(SHADE, "shade");

  // The curated area is the specific label and stays as it is; the region is the broad Find Tracks
  // grouping and comes primarily from it. Coordinates are only a FALLBACK for a missing or unknown
  // area — and that fallback is a review item, never a silent rewrite.
  let region: string | null = null;
  let area = "";
  let regionSource: "area" | "coordinates" = "area";
  const rawArea =
    typeof m.area === "string" ? m.area.normalize("NFC").replace(/\s+/g, " ").trim() : "";
  if (rawArea) {
    area = rawArea;
    region = AREA_REGION[normalizeKey(rawArea)] ?? null;
  }
  if (region === null) {
    const guess =
      latitude !== null && longitude !== null ? classifyRegion(latitude, longitude) : null;
    if (guess !== null && isRegionKey(guess)) {
      region = guess;
      regionSource = "coordinates";
      area = rawArea || (IL_REGIONS.find((r) => r.key === guess)?.he ?? guess);
      warnings.push(
        rawArea
          ? `area "${rawArea}" is not a known area — region ${guess} derived from coordinates (REVIEW)`
          : `area is missing — region ${guess} derived from coordinates (REVIEW)`,
      );
    } else {
      errors.push(rawArea ? `area "${rawArea}" is not a known area` : "area is missing");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    value: {
      name,
      description,
      country,
      distanceKm: distanceKm as number,
      climbM,
      climbInvalid,
      latitude,
      longitude,
      regionSource,
      durationMin,
      routeDifficulty: routeDifficulty as RouteDifficulty,
      season: season as TrailSeason,
      shade: shade as TrailShade,
      region: region as string,
      area,
    },
  };
}
