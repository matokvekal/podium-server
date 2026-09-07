// Coarse geographic regions for the "Browse tracks" area filter.
//
// ISRAEL ONLY for now. The eventual model is a `countries` table with a region list per
// country (see the plan's "later" section); until then the list is this constant, mirrored
// on the client (elnino-client/src/lib/regions.ts) so the create form's dropdown and the
// picker's filter offer the same options and `classifyRegion` gives the same answer on both.
//
// The bounding boxes are DELIBERATELY ROUGH — the regions are broad bands and Israel is small,
// so a point-in-box test off the route's start coordinate is accurate enough to pre-select
// the create form's dropdown, which the organiser then confirms or corrects. They are not a
// definition of anything and are expected to be tuned. Overlaps are fine: classifyRegion
// returns the SMALLEST box that contains the point, so a nested region (Eilat inside the
// Arava, the city centre inside the Sharon) wins over the band around it.

export interface Region {
  key: string;
  /** Hebrew label — what the dropdown shows. */
  he: string;
  /** English label — for non-RTL surfaces / logs. */
  en: string;
  /** [minLat, minLon, maxLat, maxLon] — rough. */
  bbox: [number, number, number, number];
}

/** The keys, as a literal tuple so `z.enum(REGION_KEYS)` types correctly. Keep in sync with
 *  IL_REGIONS below. */
export const REGION_KEYS = [
  "golan",
  "north",
  "sharon",
  "center",
  "jerusalem",
  "shfela",
  "jordan_valley",
  "dead_sea",
  "negev",
  "arava",
  "eilat",
] as const;

export type RegionKey = (typeof REGION_KEYS)[number];

export const IL_REGIONS: Region[] = [
  { key: "golan", he: "גולן", en: "Golan", bbox: [32.85, 35.6, 33.35, 35.95] },
  { key: "north", he: "צפון", en: "North", bbox: [32.5, 34.9, 33.35, 35.68] },
  { key: "sharon", he: "השרון", en: "Sharon", bbox: [32.05, 34.8, 32.55, 35.05] },
  { key: "center", he: "מרכז", en: "Center", bbox: [31.88, 34.7, 32.1, 35.02] },
  {
    key: "jerusalem",
    he: "ירושלים וההרים",
    en: "Jerusalem & Hills",
    bbox: [31.65, 34.95, 31.92, 35.35],
  },
  { key: "shfela", he: "שפלה", en: "Judean Lowlands", bbox: [31.45, 34.55, 31.95, 34.98] },
  {
    key: "jordan_valley",
    he: "בקעת הירדן",
    en: "Jordan Valley",
    bbox: [31.85, 35.33, 32.9, 35.62],
  },
  { key: "dead_sea", he: "ים המלח", en: "Dead Sea", bbox: [30.85, 35.25, 31.8, 35.55] },
  { key: "negev", he: "נגב", en: "Negev", bbox: [29.9, 34.3, 31.5, 35.3] },
  { key: "arava", he: "ערבה", en: "Arava", bbox: [29.62, 34.88, 30.9, 35.45] },
  { key: "eilat", he: "אילת", en: "Eilat", bbox: [29.5, 34.86, 29.62, 35.02] },
];

const REGION_KEY_SET = new Set<string>(REGION_KEYS);

export function isRegionKey(value: unknown): value is RegionKey {
  return typeof value === "string" && REGION_KEY_SET.has(value);
}

const bboxArea = ([minLat, minLon, maxLat, maxLon]: Region["bbox"]) =>
  (maxLat - minLat) * (maxLon - minLon);

function contains([minLat, minLon, maxLat, maxLon]: Region["bbox"], lat: number, lon: number) {
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}

/**
 * The region whose (rough) box contains this point — the smallest one when several do, so a
 * nested region beats the band around it. `null` when the point is outside every box (e.g. a
 * ride abroad, or bad coordinates) — the form then leaves the dropdown unset.
 */
export function classifyRegion(
  lat: number | null | undefined,
  lon: number | null | undefined,
): string | null {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best: Region | null = null;
  for (const region of IL_REGIONS) {
    if (!contains(region.bbox, lat, lon)) continue;
    if (best === null || bboxArea(region.bbox) < bboxArea(best.bbox)) best = region;
  }
  return best?.key ?? null;
}
