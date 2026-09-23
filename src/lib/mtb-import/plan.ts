// Everything the importer decides about ONE track folder, computed without touching a database.
// Reading the folder is the only I/O, and it is read-only: the GPX bytes are hashed, parsed for the
// display geometry, and left exactly as they are.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { haversineDistanceKm } from "../geo.js";
import {
  ascentFromElevations,
  distanceToRegionKm,
  REGION_REVIEW_KM,
  seedCounts,
} from "./derive.js";
import { type GpxPart, type GpxPoint, parseGpx } from "./gpx.js";
import { type MtbTrackMetadata, normalizeMtbMetadata } from "./metadata.js";
import {
  DEFAULT_CEILING_POINTS,
  DEFAULT_TOLERANCE_M,
  type DeviationStats,
  measureDeviation,
  previewLine,
  simplifyRoute,
} from "./simplify.js";

/** The ledger identity of a track. The FOLDER, never the display name: three curated names are
 *  duplicated, and a rename must not turn an imported track into a new one. */
export function sourceKeyFor(folder: string): string {
  return `mtb-singels:${folder.normalize("NFC")}`;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type StoredPoint = [number, number] | { lat: number; lng: number; ele: number | null };

export interface GeometryReport {
  originalPoints: number;
  simplifiedPoints: number;
  previewPoints: number;
  /** 100 * (1 - simplified / original). */
  reductionPercent: number;
  toleranceM: number;
  ceilingApplied: boolean;
  deviation: DeviationStats;
  /** Haversine length of the original / simplified line, km. */
  originalLengthKm: number;
  simplifiedLengthKm: number;
  /** Points that carried <ele> in the original / in the stored line. */
  originalWithEle: number;
  storedWithEle: number;
  parts: GpxPart[];
  /** Largest straight jump between one part's last point and the next part's first, km. */
  maxPartGapKm: number;
}

export interface TrackPlan {
  folder: string;
  sourceKey: string;
  folderPath: string;
  gpxFilename: string;
  gpxPath: string;
  gpxSha256: string;
  gpxByteLength: number;
  metadata: MtbTrackMetadata;
  /** The climb that gets stored: the curated value, else the GPX-derived ascent, else null
   *  (unknown). Never negative. */
  climbM: number | null;
  climbSource: "metadata" | "gpx" | "unknown";
  /** Imported starting popularity for routes.imported_like_count / imported_download_count
   *  (sql/043) — independent draws in 0..79, deterministic per source key. */
  seedLikes: number;
  seedDownloads: number;
  /** Things a human should look at. A track with any is held back unless explicitly allowed. */
  reviewFlags: string[];
  /** routes.track_points — objects with `ele` when any point has it, plain tuples otherwise
   *  (the two shapes eventRoute.queries.ts already reads). */
  trackPoints: StoredPoint[];
  /** routes.preview_points — [lat, lng] tuples, as the card renderer already reads. */
  previewPoints: [number, number][];
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  /** Bounding box of the ORIGINAL points, so the stored box is never smaller than the real line. */
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  geometry: GeometryReport;
  warnings: string[];
}

export type PlanResult =
  | { ok: true; plan: TrackPlan }
  | { ok: false; folder: string; errors: string[] };

function lengthKm(points: readonly GpxPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineDistanceKm(points[i - 1], points[i]);
  return total;
}

export interface PlanOptions {
  toleranceM?: number;
  ceilingPoints?: number;
}

export function planTrack(
  tracksRoot: string,
  folder: string,
  options: PlanOptions = {},
): PlanResult {
  const errors: string[] = [];
  const folderPath = path.join(tracksRoot, folder);

  let files: string[];
  try {
    if (!statSync(folderPath).isDirectory()) throw new Error("not a directory");
    files = readdirSync(folderPath);
  } catch {
    return { ok: false, folder, errors: ["folder is not readable"] };
  }

  const gpxFiles = files.filter((f) => /\.gpx$/i.test(f));
  if (gpxFiles.length !== 1) {
    errors.push(`expected exactly one .gpx, found ${gpxFiles.length}`);
  }
  if (!files.includes("metadata.json")) errors.push("metadata.json is missing");
  if (errors.length > 0) return { ok: false, folder, errors };

  let rawMetadata: unknown;
  try {
    rawMetadata = JSON.parse(readFileSync(path.join(folderPath, "metadata.json"), "utf8"));
  } catch (err) {
    return { ok: false, folder, errors: [`metadata.json is not valid JSON (${String(err)})`] };
  }
  const meta = normalizeMtbMetadata(rawMetadata);
  if (!meta.ok) return { ok: false, folder, errors: meta.errors };

  const gpxFilename = gpxFiles[0];
  const gpxPath = path.join(folderPath, gpxFilename);
  const gpxBytes = readFileSync(gpxPath);
  if (gpxBytes.length === 0) return { ok: false, folder, errors: ["the GPX file is empty"] };

  const parsed = parseGpx(gpxBytes.toString("utf8"));
  if (parsed.points.length < 2) {
    return { ok: false, folder, errors: [`GPX has ${parsed.points.length} valid points (need 2)`] };
  }

  const warnings = [...meta.warnings];
  const simplified = simplifyRoute(parsed.points, {
    toleranceM: options.toleranceM ?? DEFAULT_TOLERANCE_M,
    ceilingPoints: options.ceilingPoints ?? DEFAULT_CEILING_POINTS,
  });
  if (simplified.ceilingApplied) {
    warnings.push(`safety ceiling relaxed the tolerance to ${simplified.toleranceM.toFixed(1)} m`);
  }
  const deviation = measureDeviation(parsed.points, simplified.indices, simplified.toleranceM);
  const preview = previewLine(simplified.points);

  const storedWithEle = simplified.points.filter((p) => p.ele !== null).length;
  const trackPoints: StoredPoint[] =
    storedWithEle > 0
      ? simplified.points.map((p) => ({ lat: p.lat, lng: p.lng, ele: p.ele }))
      : simplified.points.map((p): [number, number] => [p.lat, p.lng]);

  let maxPartGapKm = 0;
  for (let i = 1; i < parsed.parts.length; i += 1) {
    const before = parsed.points[parsed.parts[i].start - 1];
    const after = parsed.points[parsed.parts[i].start];
    maxPartGapKm = Math.max(maxPartGapKm, haversineDistanceKm(before, after));
  }
  if (parsed.parts.length > 1) {
    warnings.push(
      `${parsed.parts.length} track parts joined in file order (largest gap ${maxPartGapKm.toFixed(1)} km); the original GPX keeps them separate`,
    );
  }

  // ---- climb: curated if valid, else recomputed from the ORIGINAL GPX elevation, else unknown ----
  let climbM = meta.value.climbM;
  let climbSource: TrackPlan["climbSource"] = climbM === null ? "unknown" : "metadata";
  if (climbM === null) {
    const ascent = ascentFromElevations(parsed.points.map((p) => p.ele));
    if (ascent.ascentM !== null) {
      climbM = ascent.ascentM;
      climbSource = "gpx";
      warnings.push(`climb taken from GPX elevation: ${climbM} m`);
    } else {
      warnings.push(`no reliable climb (${ascent.reason}) — stored as unknown`);
    }
  }

  // ---- region sanity: flag, never silently change ----
  const reviewFlags: string[] = [];
  if (meta.value.regionSource === "coordinates") {
    reviewFlags.push("region derived from coordinates (area missing or unknown)");
  }
  const { latitude, longitude } = meta.value;
  if (latitude !== null && longitude !== null) {
    const away = distanceToRegionKm(meta.value.region, latitude, longitude);
    if (away !== null && away >= REGION_REVIEW_KM) {
      reviewFlags.push(
        `coordinates are ${away.toFixed(0)} km from region ${meta.value.region} (area "${meta.value.area}")`,
      );
    }
  }

  const originalLengthKm = lengthKm(parsed.points);
  const declared = meta.value.distanceKm;
  if (Math.abs(originalLengthKm - declared) > 1 && Math.abs(originalLengthKm - declared) / declared > 0.15) {
    warnings.push(
      `curated distance ${declared} km vs GPX length ${originalLengthKm.toFixed(1)} km (>15%)`,
    );
  }

  let minLat = parsed.points[0].lat;
  let maxLat = minLat;
  let minLon = parsed.points[0].lng;
  let maxLon = minLon;
  for (const p of parsed.points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLon) minLon = p.lng;
    if (p.lng > maxLon) maxLon = p.lng;
  }

  const first = simplified.points[0];
  const last = simplified.points[simplified.points.length - 1];
  return {
    ok: true,
    plan: {
      folder,
      sourceKey: sourceKeyFor(folder),
      folderPath,
      gpxFilename,
      gpxPath,
      gpxSha256: sha256(gpxBytes),
      gpxByteLength: gpxBytes.length,
      metadata: meta.value,
      climbM,
      climbSource,
      ...(() => {
        const seeds = seedCounts(sourceKeyFor(folder));
        return { seedLikes: seeds.likes, seedDownloads: seeds.downloads };
      })(),
      reviewFlags,
      trackPoints,
      previewPoints: preview.map((p): [number, number] => [p.lat, p.lng]),
      start: { lat: first.lat, lng: first.lng },
      end: { lat: last.lat, lng: last.lng },
      bbox: { minLat, minLon, maxLat, maxLon },
      geometry: {
        originalPoints: parsed.points.length,
        simplifiedPoints: simplified.points.length,
        previewPoints: preview.length,
        reductionPercent: 100 * (1 - simplified.points.length / parsed.points.length),
        toleranceM: simplified.toleranceM,
        ceilingApplied: simplified.ceilingApplied,
        deviation,
        originalLengthKm,
        simplifiedLengthKm: lengthKm(simplified.points),
        originalWithEle: parsed.points.filter((p) => p.ele !== null).length,
        storedWithEle,
        parts: parsed.parts,
        maxPartGapKm,
      },
      warnings,
    },
  };
}
