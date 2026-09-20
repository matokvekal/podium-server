// One-time, resumable import of the curated MTB library (MTB-SINGELS/tracks) into El Nino.
//
//   npx tsx src/scripts/importMtbTracks.ts                       dry-run over every folder (no DB)
//   npx tsx src/scripts/importMtbTracks.ts --folder <name>       dry-run for one folder
//   IMPORT_DATABASE_URL=... npx tsx src/scripts/importMtbTracks.ts --execute --yes [--folder X | --limit N]
//   IMPORT_DATABASE_URL=... npx tsx src/scripts/importMtbTracks.ts --verify         re-check imported rows
//   IMPORT_DATABASE_URL=... npx tsx src/scripts/importMtbTracks.ts --rollback <folder> --reason "..." --yes
//                                       remove ONE imported track (rows + ledger) and put its folder
//                                       back in tracks/. Refuses if real likes/copies/riders exist.
//
// SAFETY
//   * The target is taken ONLY from IMPORT_DATABASE_URL (or --database-url). It never reads
//     DATABASE_URL or .env, so it cannot fall through to whatever the server is configured for.
//   * It refuses any host that is not localhost / 127.0.0.1 / ::1. There is no override: staging or
//     a remote dev database means adding its exact host to ALLOWED_HOSTS in this file on purpose.
//     The known production host is refused by name as well. The single way past that is
//     --allow-host <host> naming the target host EXACTLY (per run, on the command line).
//   * --source <dir> reads the folders from somewhere other than tracks/ (e.g. the already-validated
//     MTB-SINGELS/DONE). Nothing is moved when the source already is DONE.
//   * --tag <name> suffixes the log / report / dry-run CSV, so a run against another database never
//     appends to, or overwrites, the files of the run before it.
//
// WHAT ONE TRACK BECOMES (one transaction each)
//   events           a finished, PUBLIC ride owned by the library owner — what Find Tracks lists
//   event_members    the owner row
//   routes           the display geometry (Douglas-Peucker, metres), climb, distance, seed counts
//   event_routes     the link
//   route_gpx_files  the ORIGINAL file, byte for byte
//   import_log       the ledger: source_key = the FOLDER, so a rename can never re-import a track
//
// IDEMPOTENT + RESUMABLE
//   A folder whose ledger row exists is never inserted again. It is re-verified, and only if it
//   verifies is it moved to DONE (this finishes an interrupted run). A folder that fails stays in
//   tracks/ and the run continues with the next. Nothing is ever overwritten or updated in place.
//
// A FOLDER MOVES TO MTB-SINGELS/DONE ONLY AFTER everything read back from the database matches the
// plan and the stored GPX bytes hash to the source file's hash (re-read from disk after the write).

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import pg from "pg";
import { datePrefix, letterSuffix } from "../lib/event-code.js";
import { planTrack, sourceKeyFor, type TrackPlan } from "../lib/mtb-import/plan.js";
import { previewFromStored, toStoredThumb } from "../lib/route-thumb.js";

const ROOT = "E:/DEV2026/ElNino/MTB-SINGELS";
const TRACKS = `${ROOT}/tracks`;
const DONE = `${ROOT}/DONE`;
const MANIFEST = `${ROOT}/curation/metadata_sha256_after_fixes.json`;
const STAMP = "2026-09-20";
const OWNER_EMAIL = "mictavim@gmail.com"; // same owner as the Road (Garmin) import
const BATCH = `mtb-singels-${STAMP}`;

/** routes.thumb_points for a plan — SQL NULL (not the JSON text "null") when there is no line. */
function thumbJson(plan: TrackPlan): string | null {
  const thumb = toStoredThumb(previewFromStored(plan.trackPoints));
  return thumb ? JSON.stringify(thumb) : null;
}

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const REFUSED_HOSTS = new Set(["191.215.39.19"]); // production

// ---- args -----------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const TAG = val("--tag") ? `_${val("--tag")}` : "";
const LOG = `${ROOT}/import_log_${STAMP}${TAG}.jsonl`;
const REPORT = `${ROOT}/import_report_${STAMP}${TAG}.csv`;
const DRY_REPORT = `${ROOT}/import_dry_run_${STAMP}${TAG}.csv`;
/** Where the track folders are read from. */
const SOURCE = val("--source") ?? TRACKS;
const SOURCE_IS_DONE = path.resolve(SOURCE) === path.resolve(DONE);
const EXECUTE = has("--execute");
const VERIFY_ONLY = has("--verify");
const YES = has("--yes");
const ONLY = val("--folder");
const LIMIT = val("--limit") ? Number(val("--limit")) : null;
const SEED_DEV_OWNER = has("--seed-dev-owner");
const OWNER_NICKNAME = val("--owner-nickname");
const CREATE_OWNER = has("--create-owner");
const ALLOW_MODIFIED_GPX = has("--allow-modified-gpx");
const ROLLBACK = val("--rollback");
const REASON = val("--reason") ?? "rolled back by request";

const log = (...a: unknown[]) => console.log(...a);

// ---- target database ------------------------------------------------------------------------
function targetUrl(): string | null {
  return val("--database-url") ?? process.env.IMPORT_DATABASE_URL ?? null;
}

function assertSafeTarget(url: string): { host: string; database: string; remote: boolean } {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const remote = !ALLOWED_HOSTS.has(host);
  // The one way past the refusal: --allow-host naming this EXACT host on the command line. Exact
  // string match, no patterns, no env var — a deliberate, visible, per-run act. REFUSED_HOSTS
  // stays, so without the flag production is still refused.
  if (remote && val("--allow-host") === host) {
    return { host, database: u.pathname.replace(/^\//, ""), remote };
  }
  if (REFUSED_HOSTS.has(host)) {
    throw new Error(
      `refusing ${host}: that is the production database (--allow-host ${host} to import there on purpose)`,
    );
  }
  if (remote) {
    throw new Error(
      `refusing host "${host}": only ${[...ALLOWED_HOSTS].join(", ")} are allowed. ` +
        "Add a staging host to ALLOWED_HOSTS deliberately if that is intended.",
    );
  }
  return { host, database: u.pathname.replace(/^\//, ""), remote };
}

// ---- helpers --------------------------------------------------------------------------------
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function record(entry: Record<string, unknown>) {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function listFolders(): string[] {
  const all = readdirSync(SOURCE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, "he"));
  if (ONLY) return all.filter((f) => f === ONLY);
  return LIMIT ? all.slice(0, LIMIT) : all;
}

function loadManifest(): Record<string, string> {
  return existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
}

/** null when the folder's metadata is exactly what curation wrote; otherwise why not. */
function manifestProblem(folder: string, manifest: Record<string, string>): string | null {
  const expected = manifest[folder];
  if (!expected) return "no entry in the curation manifest";
  const actual = sha(readFileSync(path.join(SOURCE, folder, "metadata.json")));
  return actual === expected
    ? null
    : "metadata.json changed after curation (a concurrent writer?) — refusing to import it";
}

/** The download-time SHA-256 of every original GPX, keyed by the site's old slug (metadata.slug). */
const ORIGINALS = `${ROOT}/gpx_sha256_before.json`;

/**
 * A GPX that no longer hashes to what was originally downloaded has been modified since — the
 * "original" being stored would not be one. That happened once already (a stray find-and-replace
 * rewrote text inside 13 files), so it is checked rather than assumed. null = pristine, or nothing
 * to compare against (16 files have no entry).
 */
function originalGpxProblem(folder: string, gpxSha256: string): string | null {
  if (ALLOW_MODIFIED_GPX || !existsSync(ORIGINALS)) return null;
  const originals = JSON.parse(readFileSync(ORIGINALS, "utf8")) as Record<string, { sha256: string }>;
  const meta = JSON.parse(readFileSync(path.join(SOURCE, folder, "metadata.json"), "utf8")) as { slug?: string };
  const expected = originals[meta.slug ?? ""] ?? originals[folder];
  if (!expected || expected.sha256 === gpxSha256) return null;
  return "the GPX no longer matches the SHA-256 it had when downloaded — it has been modified (use --allow-modified-gpx to import it anyway)";
}

// ---- dry run --------------------------------------------------------------------------------
function dryRun() {
  const manifest = loadManifest();
  const folders = listFolders();
  const rows: string[] = [
    "folder,status,name,region,area,distance_km,climb_m,climb_source,duration_min,difficulty,season,shade,orig_points,stored_points,reduction_pct,max_dev_m,seed_likes,seed_downloads,review,warnings",
  ];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  let ok = 0;
  let bad = 0;
  let orig = 0;
  let stored = 0;
  const reds: number[] = [];
  const counts: number[] = [];
  let review = 0;
  for (const folder of folders) {
    const plan = planTrack(SOURCE, folder);
    const stale = manifestProblem(folder, manifest);
    if (!plan.ok || stale) {
      bad += 1;
      rows.push([folder, "FAIL", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", (plan.ok ? [] : plan.errors).concat(stale ? [stale] : []).join(" | ")].map(esc).join(","));
      continue;
    }
    const p = plan.plan;
    ok += 1;
    orig += p.geometry.originalPoints;
    stored += p.geometry.simplifiedPoints;
    reds.push(p.geometry.reductionPercent);
    counts.push(p.geometry.simplifiedPoints);
    if (p.reviewFlags.length) review += 1;
    rows.push(
      [folder, "OK", p.metadata.name, p.metadata.region, p.metadata.area, p.metadata.distanceKm, p.climbM ?? "", p.climbSource, p.metadata.durationMin ?? "", p.metadata.routeDifficulty, p.metadata.season, p.metadata.shade, p.geometry.originalPoints, p.geometry.simplifiedPoints, p.geometry.reductionPercent.toFixed(1), p.geometry.deviation.maxM.toFixed(2), p.seedLikes, p.seedDownloads, p.reviewFlags.join(" | "), p.warnings.join(" | ")].map(esc).join(","),
    );
  }
  writeFileSync(DRY_REPORT, `\uFEFF${rows.join("\r\n")}\r\n`);
  counts.sort((a, b) => a - b);
  reds.sort((a, b) => a - b);
  log(`dry-run: ${folders.length} folders  plannable ${ok}  failing ${bad}  region-flagged ${review}`);
  if (ok > 0) {
    log(
      `geometry: ${orig} -> ${stored} points (${(100 * (1 - stored / orig)).toFixed(1)}% reduction); stored per track min/median/p95/max = ${counts[0]}/${counts[counts.length >> 1]}/${counts[Math.floor(counts.length * 0.95)]}/${counts.at(-1)}; reduction% min/median/max = ${reds[0].toFixed(1)}/${reds[reds.length >> 1].toFixed(1)}/${reds.at(-1)?.toFixed(1)}`,
    );
  }
  log(`report: ${DRY_REPORT}`);
}

// ---- DB work --------------------------------------------------------------------------------
type Db = pg.Client;

async function preflight(db: Db): Promise<number> {
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const need: [string, string, string][] = [
    ["events", "route_difficulty", "041"],
    ["events", "season", "041"],
    ["events", "shade", "041"],
    ["events", "region", "032"],
    ["events", "country", "030"],
    ["routes", "imported_like_count", "043"],
    ["routes", "imported_download_count", "043"],
  ];
  for (const [t, c, mig] of need) {
    const r = await one(
      "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
      [t, c],
    );
    if (r.length === 0) throw new Error(`${t}.${c} is missing — run sql/${mig}-*.sql on this database first`);
  }
  if ((await one("SELECT to_regclass('public.route_gpx_files') AS t"))[0].t == null) {
    throw new Error("route_gpx_files is missing — run sql/042-route-original-gpx.sql first");
  }

  // A dedicated NON-HUMAN library owner, looked up by nickname (--owner-nickname MIKI) instead of by
  // a person's e-mail. It is only a technical owner for imported public tracks: no login (inactive,
  // and no auth_identities row is ever written), zero limits (it can organise nothing) and excluded
  // from the Statistics backfill. --create-owner creates exactly that user when it does not exist.
  if (OWNER_NICKNAME) {
    let found = await one("SELECT id FROM users WHERE nickname = $1", [OWNER_NICKNAME]);
    if (found.length === 0 && CREATE_OWNER) {
      await db.query("BEGIN");
      try {
        const u = await one(
          `INSERT INTO users (first_name, nickname, is_active, stats_backfill_excluded)
           VALUES ($1, $1, FALSE, TRUE) RETURNING id`,
          [OWNER_NICKNAME],
        );
        await db.query(
          `INSERT INTO user_limits
             (user_id, events_per_week, participants_per_event, groups_per_event, teams_owned,
              concurrent_live_events, note)
           VALUES ($1, 0, 0, 0, 0, 0, 'library/system owner for imported public tracks — not a person')`,
          [u[0].id],
        );
        await db.query("COMMIT");
        found = [{ id: u[0].id }];
        log(`  created the library owner "${OWNER_NICKNAME}", user_id=${u[0].id}`);
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      }
    }
    if (found.length !== 1) {
      throw new Error(
        `the library owner "${OWNER_NICKNAME}" resolves to ${found.length} users, expected 1 (use --create-owner to create it)`,
      );
    }
    const limits = await one("SELECT 1 FROM user_limits WHERE user_id = $1", [found[0].id]);
    if (limits.length === 0) {
      throw new Error(`the library owner (user ${found[0].id}) has no user_limits row`);
    }
    await db.query(`CREATE TABLE IF NOT EXISTS import_log (
      source_key TEXT PRIMARY KEY, event_id UUID NOT NULL, route_id BIGINT,
      event_code VARCHAR(32) NOT NULL, batch TEXT NOT NULL, rider_count INT, download_count INT,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    return Number(found[0].id);
  }

  let owner = await one(
    "SELECT DISTINCT user_id FROM auth_identities WHERE lower(email) = lower($1)",
    [OWNER_EMAIL],
  );
  if (owner.length === 0 && SEED_DEV_OWNER) {
    const u = await one(
      "INSERT INTO users (first_name, nickname) VALUES ('Elnino', 'Elnino Tracks') RETURNING id",
    );
    await db.query(
      "INSERT INTO auth_identities (user_id, provider, provider_user_id, email) VALUES ($1, 'seed', 'mtb-import-owner', $2)",
      [u[0].id, OWNER_EMAIL],
    );
    // Every real user has a user_limits row (written with the user); the API refuses to serve a
    // ride whose owner has none, so a seeded dev owner needs one too.
    await db.query(
      "INSERT INTO user_limits (user_id, events_per_week, participants_per_event, groups_per_event, teams_owned, note) VALUES ($1, 3, 50, 5, 1, 'dev library owner')",
      [u[0].id],
    );
    owner = [{ user_id: u[0].id }];
    log(`  (dev) created the library owner account, user_id=${u[0].id}`);
  }
  if (owner.length !== 1) {
    throw new Error(`the library owner (${OWNER_EMAIL}) resolves to ${owner.length} users, expected 1 (use --seed-dev-owner on a dev database)`);
  }
  const limits = await one("SELECT 1 FROM user_limits WHERE user_id = $1", [owner[0].user_id]);
  if (limits.length === 0) {
    throw new Error(`the library owner (user ${owner[0].user_id}) has no user_limits row — the API cannot serve their rides`);
  }
  await db.query(`CREATE TABLE IF NOT EXISTS import_log (
      source_key TEXT PRIMARY KEY, event_id UUID NOT NULL, route_id BIGINT,
      event_code VARCHAR(32) NOT NULL, batch TEXT NOT NULL, rider_count INT, download_count INT,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  return Number(owner[0].user_id);
}

async function nextCode(db: Db, prefix: string): Promise<string> {
  const { rows } = await db.query("SELECT code FROM events WHERE code LIKE $1", [`${prefix}%`]);
  const used = new Set(rows.map((r) => String(r.code).slice(8).toUpperCase()));
  let n = 0;
  while (used.has(letterSuffix(n))) n += 1;
  return `${prefix}${letterSuffix(n)}`;
}

async function insertTrack(db: Db, plan: TrackPlan, ownerId: number) {
  // The bytes are read HERE, at write time, and must still be the bytes that were planned.
  const gpxBytes = readFileSync(plan.gpxPath);
  if (sha(gpxBytes) !== plan.gpxSha256) throw new Error("the GPX file changed between planning and writing");

  const m = plan.metadata;
  await db.query("BEGIN");
  try {
    const now = new Date();
    const code = await nextCode(db, datePrefix(now));
    const eventId = (await db.query("SELECT gen_random_uuid() AS id")).rows[0].id as string;

    await db.query(
      `INSERT INTO events (
         id, code, name, type, requires_bib, starts_at, ends_at, is_active, owner_id, display_mode,
         status, visibility, description, location, area, finished_at,
         show_event_info, show_participants, show_route, show_live_locations, show_history_locations, show_results,
         activity_type, level, organizer_group, elevation_gain_m, duration_min, rest_stops,
         is_accessible, has_support_vehicle, region, country, route_difficulty, season, shade,
         created_at, updated_at)
       VALUES ($1,$2,$3,'RIDE',FALSE,$4,NULL,FALSE,$5,'standard',
         'finished','public',$6,NULL,$7,$4,
         TRUE,FALSE,TRUE,FALSE,FALSE,TRUE,
         'mtb',NULL,NULL,$8,$9,NULL,
         FALSE,FALSE,$10,$11,$12,$13,$14,
         $4,$4)`,
      [eventId, code, m.name, now.toISOString(), ownerId, m.description, m.area, plan.climbM, m.durationMin, m.region, m.country, m.routeDifficulty, m.season, m.shade],
    );
    await db.query(
      `INSERT INTO event_members (event_id, user_id, role, joined_at) VALUES ($1,$2,'owner',$3)`,
      [eventId, ownerId, now.toISOString()],
    );

    const route = await db.query(
      `INSERT INTO routes (
         owner_id, name, route_type, source, distance_km, elevation_m, track_points, markers,
         preview_points, point_count, is_public, place_name, start_lat, start_lon, end_lat, end_lon,
         bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon,
         imported_like_count, imported_download_count, created_at, updated_at, thumb_points)
       VALUES ($1,$2,'mtb','gpx',$3,$4,$5::jsonb,NULL,$6::jsonb,$7,TRUE,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,$20::jsonb)
       RETURNING id`,
      [ownerId, m.name, m.distanceKm, plan.climbM, JSON.stringify(plan.trackPoints), JSON.stringify(plan.previewPoints), plan.trackPoints.length, m.area, plan.start.lat, plan.start.lng, plan.end.lat, plan.end.lng, plan.bbox.minLat, plan.bbox.minLon, plan.bbox.maxLat, plan.bbox.maxLon, plan.seedLikes, plan.seedDownloads, now.toISOString(),
        // The 60-point card preview (sql/046), derived from the stored line — never from the GPX.
        thumbJson(plan)],
    );
    const routeId = Number(route.rows[0].id);
    await db.query("INSERT INTO event_routes (event_id, route_id) VALUES ($1,$2)", [eventId, routeId]);
    await db.query(
      `INSERT INTO route_gpx_files (route_id, content, sha256, byte_length, filename) VALUES ($1,$2,$3,$4,$5)`,
      [routeId, gpxBytes, sha(gpxBytes), gpxBytes.length, plan.gpxFilename],
    );
    await db.query(
      `INSERT INTO import_log (source_key, event_id, route_id, event_code, batch, rider_count, download_count)
       VALUES ($1,$2,$3,$4,$5,0,0)`,
      [plan.sourceKey, eventId, routeId, code, BATCH],
    );
    await db.query("COMMIT");
    return { eventId, routeId, code };
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/** Everything read BACK from the database (and the disk) against the plan. Empty = verified. */
async function verifyTrack(db: Db, plan: TrackPlan, ownerId: number): Promise<string[]> {
  const bad: string[] = [];
  const led = (await db.query("SELECT * FROM import_log WHERE source_key = $1", [plan.sourceKey])).rows[0];
  if (!led) return ["no ledger row"];
  const ev = (await db.query("SELECT * FROM events WHERE id = $1", [led.event_id])).rows[0];
  const rt = (await db.query("SELECT r.*, jsonb_array_length(r.track_points) AS n_points, jsonb_array_length(r.preview_points) AS n_preview FROM routes r WHERE r.id = $1", [led.route_id])).rows[0];
  if (!ev) return ["event row missing"];
  if (!rt) return ["route row missing"];
  const m = plan.metadata;
  const eq = (label: string, a: unknown, b: unknown) => {
    if (String(a ?? null) !== String(b ?? null)) bad.push(`${label}: db=${String(a)} plan=${String(b)}`);
  };
  eq("event.name", ev.name, m.name);
  eq("event.status", ev.status, "finished");
  eq("event.visibility", ev.visibility, "public");
  eq("event.activity_type", ev.activity_type, "mtb");
  eq("event.type", ev.type, "RIDE");
  eq("event.owner_id", ev.owner_id, ownerId);
  eq("event.region", ev.region, m.region);
  eq("event.area", ev.area, m.area);
  eq("event.country", ev.country?.trim(), m.country);
  eq("event.route_difficulty", ev.route_difficulty, m.routeDifficulty);
  eq("event.season", ev.season, m.season);
  eq("event.shade", ev.shade, m.shade);
  eq("event.duration_min", ev.duration_min, m.durationMin);
  eq("event.elevation_gain_m", ev.elevation_gain_m, plan.climbM);
  if (ev.elevation_gain_m !== null && Number(ev.elevation_gain_m) < 0) bad.push("event climb is negative");
  eq("route.name", rt.name, m.name);
  eq("route.route_type", rt.route_type, "mtb");
  eq("route.source", rt.source, "gpx");
  eq("route.is_public", rt.is_public, true);
  eq("route.distance_km", rt.distance_km, m.distanceKm);
  eq("route.elevation_m", rt.elevation_m, plan.climbM);
  if (rt.elevation_m !== null && Number(rt.elevation_m) < 0) bad.push("route climb is negative");
  eq("route.point_count", rt.point_count, plan.trackPoints.length);
  eq("route.track_points length", rt.n_points, plan.trackPoints.length);
  eq("route.preview length", rt.n_preview, plan.previewPoints.length);
  eq("route.imported_like_count", rt.imported_like_count, plan.seedLikes);
  eq("route.imported_download_count", rt.imported_download_count, plan.seedDownloads);
  const links = (await db.query("SELECT count(*)::int AS c FROM event_routes WHERE event_id = $1 AND route_id = $2", [led.event_id, led.route_id])).rows[0].c;
  eq("event_routes links", links, 1);

  // The original file: what is stored, hashed again here, against the plan AND the file on disk now.
  const gpx = (await db.query("SELECT content, sha256, byte_length, filename FROM route_gpx_files WHERE route_id = $1", [led.route_id])).rows[0];
  if (!gpx) bad.push("original GPX not stored");
  else {
    const stored = gpx.content as Buffer;
    const onDisk = existsSync(plan.gpxPath) ? readFileSync(plan.gpxPath) : null;
    eq("gpx stored sha256 column", gpx.sha256?.trim(), plan.gpxSha256);
    eq("gpx stored bytes sha256", sha(stored), plan.gpxSha256);
    eq("gpx byte_length", gpx.byte_length, plan.gpxByteLength);
    if (onDisk) eq("gpx source file sha256 now", sha(onDisk), plan.gpxSha256);
  }
  // Displayed counts = seed + real rows (none exist yet, so exactly the seed).
  const likes = await db.query("SELECT r.imported_like_count + (SELECT count(*) FROM route_likes WHERE route_id = r.id) AS n FROM routes r WHERE r.id = $1", [led.route_id]).catch(() => null);
  if (likes && Number(likes.rows[0].n) < plan.seedLikes) bad.push("displayed likes are below the seed");
  return bad;
}

function moveToDone(folder: string) {
  if (SOURCE_IS_DONE) return; // already where imported folders live
  mkdirSync(DONE, { recursive: true });
  const target = path.join(DONE, folder);
  if (existsSync(target)) throw new Error(`${target} already exists — refusing to overwrite`);
  renameSync(path.join(TRACKS, folder), target);
}

async function run() {
  const url = targetUrl();
  if (!url) throw new Error("set IMPORT_DATABASE_URL (or pass --database-url) to a localhost database");
  const { host, database, remote } = assertSafeTarget(url);
  log(`target: ${host} / ${database}${remote ? " (REMOTE — explicitly allowed with --allow-host)" : ""}`);
  if (EXECUTE && !YES) throw new Error("--execute needs --yes");

  // A remote database gets the same TLS setting the server itself uses for it (src/db/pool.ts).
  const db = new pg.Client({
    connectionString: url,
    keepAlive: true,
    ssl: remote ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();
  const manifest = loadManifest();
  const totals = { imported: 0, alreadyDone: 0, failed: 0, verifiedOnly: 0 };
  try {
    const ownerId = await preflight(db);
    log(`library owner user_id=${ownerId}`);
    const folders = listFolders();
    log(`${folders.length} folder(s) to process (${VERIFY_ONLY ? "verify only" : "import"})`);

    for (const folder of folders) {
      try {
        const stale = manifestProblem(folder, manifest);
        if (stale) throw new Error(stale);
        const planned = planTrack(SOURCE, folder);
        if (!planned.ok) throw new Error(planned.errors.join(" | "));
        const plan = planned.plan;
        const modified = originalGpxProblem(folder, plan.gpxSha256);
        if (modified) throw new Error(modified);

        const existing = (await db.query("SELECT 1 FROM import_log WHERE source_key = $1", [plan.sourceKey])).rows.length > 0;
        if (existing) {
          const problems = await verifyTrack(db, plan, ownerId);
          if (problems.length) throw new Error(`already in the ledger but does not verify: ${problems.join("; ")}`);
          if (!VERIFY_ONLY) moveToDone(folder);
          totals.alreadyDone += 1;
          record({ folder, status: "skipped-already-imported", moved: !VERIFY_ONLY });
          log(`  = ${folder} (already imported${VERIFY_ONLY ? "" : ", verified, moved to DONE"})`);
          continue;
        }
        if (VERIFY_ONLY) {
          record({ folder, status: "not-imported" });
          continue;
        }

        const made = await insertTrack(db, plan, ownerId);
        const problems = await verifyTrack(db, plan, ownerId);
        if (problems.length) throw new Error(`imported but verification failed: ${problems.join("; ")}`);
        moveToDone(folder);
        totals.imported += 1;
        record({
          folder,
          status: "imported",
          eventId: made.eventId,
          routeId: made.routeId,
          code: made.code,
          name: plan.metadata.name,
          points: `${plan.geometry.originalPoints}->${plan.trackPoints.length}`,
          seeds: `${plan.seedLikes}/${plan.seedDownloads}`,
          reviewFlags: plan.reviewFlags,
          warnings: plan.warnings,
        });
        log(`  + ${folder}  ${plan.metadata.name}  (${plan.geometry.originalPoints}->${plan.trackPoints.length} pts, seeds ${plan.seedLikes}/${plan.seedDownloads})`);
      } catch (err) {
        totals.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        record({ folder, status: "failed", error: message });
        log(`  ! ${folder}: ${message}`);
      }
    }
  } finally {
    await db.end();
  }
  log(`done: imported ${totals.imported}, already-imported ${totals.alreadyDone}, failed ${totals.failed}`);
  summarize();
}

/** Collapses the append-only log into one CSV row per folder (the latest event wins). */
function summarize() {
  if (!existsSync(LOG)) return;
  const latest = new Map<string, Record<string, unknown>>();
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as Record<string, unknown>;
    // An imported track stays "imported": a later refused re-run (the idempotency guard doing its
    // job) must not turn it into "failed" in the report.
    const prior = latest.get(String(e.folder));
    if (prior?.status === "imported" && e.status === "failed") continue;
    latest.set(String(e.folder), e);
  }
  const esc = (v: unknown) => {
    const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = ["folder,status,name,event_id,route_id,code,points,seeds,review_flags,error"];
  for (const e of latest.values()) {
    rows.push([e.folder, e.status, e.name ?? "", e.eventId ?? "", e.routeId ?? "", e.code ?? "", e.points ?? "", e.seeds ?? "", Array.isArray(e.reviewFlags) ? (e.reviewFlags as string[]).join(" | ") : "", e.error ?? ""].map(esc).join(","));
  }
  writeFileSync(REPORT, `\uFEFF${rows.join("\r\n")}\r\n`);
}

/** Undo ONE import: every row it created, the ledger row, and the folder back into tracks/. */
async function rollbackTrack(folder: string) {
  const url = targetUrl();
  if (!url) throw new Error("set IMPORT_DATABASE_URL (or pass --database-url) to a localhost database");
  const { host, database, remote } = assertSafeTarget(url);
  if (!YES) throw new Error("--rollback needs --yes");
  log(`target: ${host} / ${database}`);
  const key = sourceKeyFor(folder);
  const db = new pg.Client({
    connectionString: url,
    ssl: remote ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();
  try {
    const led = (await db.query("SELECT * FROM import_log WHERE source_key = $1 AND batch = $2", [key, BATCH])).rows[0];
    if (!led) throw new Error(`no ledger row for ${folder} from this import batch — nothing to roll back`);
    // Never delete anything a real person has touched.
    const real = (
      await db.query(
        `SELECT (SELECT count(*) FROM route_likes WHERE route_id = $1)::int AS likes,
                (SELECT count(*) FROM route_favorites WHERE route_id = $1)::int AS favs,
                (SELECT count(*) FROM route_copies WHERE route_id = $1)::int AS copies,
                (SELECT count(*) FROM event_participants WHERE event_id = $2)::int AS riders,
                (SELECT count(*) FROM event_routes WHERE route_id = $1 AND event_id <> $2)::int AS other_events`,
        [led.route_id, led.event_id],
      )
    ).rows[0];
    if (Object.values(real).some((n) => Number(n) > 0)) {
      throw new Error(`refusing: real data is attached (${JSON.stringify(real)})`);
    }
    const from = path.join(DONE, folder);
    const to = path.join(TRACKS, folder);
    if (!existsSync(from)) throw new Error(`${from} is not in DONE`);
    // When the run reads straight from DONE, the folders were never moved, so none is moved back.
    if (!SOURCE_IS_DONE && existsSync(to)) throw new Error(`${to} already exists — refusing to overwrite`);

    await db.query("BEGIN");
    try {
      await db.query("DELETE FROM route_gpx_files WHERE route_id = $1", [led.route_id]);
      await db.query("DELETE FROM event_routes WHERE event_id = $1", [led.event_id]);
      await db.query("DELETE FROM event_members WHERE event_id = $1", [led.event_id]);
      await db.query("DELETE FROM routes WHERE id = $1", [led.route_id]);
      await db.query("DELETE FROM events WHERE id = $1", [led.event_id]);
      await db.query("DELETE FROM import_log WHERE source_key = $1", [key]);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
    if (!SOURCE_IS_DONE) renameSync(from, to);
    record({ folder, status: "rolled-back", reason: REASON });
    log(`  - ${folder}: rolled back and returned to tracks/ (${REASON})`);
  } finally {
    await db.end();
  }
}

if (ROLLBACK) {
  rollbackTrack(ROLLBACK)
    .then(summarize)
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (!EXECUTE && !VERIFY_ONLY) dryRun();

else run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
