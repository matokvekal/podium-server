// One-off curation pass over MTB-SINGELS/tracks/*/metadata.json (2026-09-20). Dry-run by default.
//
//   npx tsx src/scripts/applyMtbCuration.ts            # report only, writes nothing
//   npx tsx src/scripts/applyMtbCuration.ts --apply    # backs up, then edits metadata.json
//
// What it does, in this order, per folder:
//   1. REPAIR  fields another process corrupted mid-session (a bad find-and-replace deleted words
//              from names, descriptions and GPX internal names) — restored from the pre-corruption
//              snapshot, and only where the snapshot agrees with the original curation report.
//   2. NAMES   replaces the non-geographic names flagged in suspicious_names_report.csv.
//   3. AREAS   fixes an area label ONLY where the coordinates make it unmistakably wrong (fixed,
//              explicit rules below); everything else is left as curated and flagged by the importer.
//   4. CLIMB   a negative climb_m is invalid: it is replaced by the ascent computed from the GPX
//              elevation, or set to null when the file has no reliable elevation.
//
// The GPX files are only READ (for step 4). Folder names — the stable import identity — are never
// changed. Every edit is written to curation/fixes_<date>.csv, and a sha256 manifest of the final
// metadata.json files is written so the importer can refuse a folder that changed afterwards.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ascentFromElevations } from "../lib/mtb-import/derive.js";
import { parseGpx } from "../lib/mtb-import/gpx.js";

const ROOT = "E:/DEV2026/ElNino/MTB-SINGELS";
const TRACKS = `${ROOT}/tracks`;
const CURATION = `${ROOT}/curation`;
const APPLY = process.argv.includes("--apply");
const STAMP = "2026-09-20";

const SNAPSHOT_PATH = `${CURATION}/snapshot_${STAMP}_pre-fixes.json`;
const FIXES_CSV = `${CURATION}/fixes_${STAMP}.csv`;
const MANIFEST = `${CURATION}/metadata_sha256_after_fixes.json`;
const BACKUP_DIR = `${ROOT}/_metadata_backup_${STAMP}_before_fixes`;

// ---------------------------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------------------------

interface SnapRow {
  folder: string;
  name: string;
  area: string;
  desc: string;
  gi: string | null;
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur.replace(/\r$/, ""));
      out.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  if (cur || row.length) {
    row.push(cur.replace(/\r$/, ""));
    out.push(row);
  }
  return out;
}

/** The pre-corruption snapshot. Written once from the audit's read; never overwritten. */
function loadSnapshot(): Map<string, SnapRow> {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(
      `${SNAPSHOT_PATH} is missing — copy the audit snapshot there first (see the report).`,
    );
  }
  const rows = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as SnapRow[];
  return new Map(rows.map((r) => [r.folder, r]));
}

/** folder -> the name the ORIGINAL curation produced. An independent second source. */
function loadCurationNames(): Map<string, string> {
  const rows = parseCsv(readFileSync(`${ROOT}/curation_report.csv`, "utf8").replace(/^\uFEFF/, ""));
  const h = rows[0];
  const fi = h.indexOf("folder");
  const ni = h.indexOf("new_name");
  return new Map(rows.slice(1).filter((r) => r.length > ni).map((r) => [r[fi], r[ni]]));
}

/** folder -> suggested name, from the reviewed audit report. */
function loadSuggestions(): Map<string, { name: string; current: string; confidence: string }> {
  const rows = parseCsv(
    readFileSync(`${ROOT}/suspicious_names_report.csv`, "utf8").replace(/^\uFEFF/, ""),
  );
  const h = rows[0];
  const fi = h.indexOf("folder");
  const ci = h.indexOf("current_name");
  const si = h.indexOf("suggested_clean_name");
  const qi = h.indexOf("suggestion_confidence");
  return new Map(
    rows
      .slice(1)
      .filter((r) => r.length > si)
      .map((r) => [r[fi], { name: r[si], current: r[ci], confidence: r[qi] }]),
  );
}

/** null = keep the current name (no evidence for a better one). */
const NAME_OVERRIDES: Record<string, string | null> = {
  "צימיצורי-דו-יומי": "חצבה – מעלה עקרבים – המכתש הגדול – מעלה אברהם",
  "סינגל-אהוד-10": "סינגלי אהוד – חורשות אלונה",
  "סינגל-אהוד-6": "סינגלי אהוד – אלונה צפון",
  "חיפה-תל-אביב-בלי-חול": "חיפה – תל אביב – דרומה",
  "בעקבות-שיירת-יחיעם": "נהריה – יחיעם – שיירת יחיעם",
  "שביל-הבנים-הדרוזים": null,
  "טל-שחר": null,
  "טל-שחר-2": null,
  "סינגל-חווה-מצפה-רמון": "מצפה רמון – הנגב הגבוה",
  מודיעין: "סביבות מודיעין",
  "בתרונות-רוחמה": "בתרונות רוחמה – מזרח",
  "בתרונות-רוחמה-2": "בתרונות רוחמה – מערב",
  "עמק-המעיינות-רכיבת-מים": null,
  "עמק-המעיינות-קצב-נינוח": null,
  "אם-העליות": "בית שמש – הרי יהודה",
  "מושבי-העמק": "עמק יזרעאל המערבי – יקנעם",
  "דרך-הנוף-הצפונית-קטע-חדש": "דרך הנוף הצפונית – בית שמש",
  "ירושלים-העירונית": "ירושלים – טדי – גשר המיתרים – ממילא – מתחם התחנה",
  "ירושלים-העירונית-וגבעת-רם": "ירושלים – טדי – גשר המיתרים – גבעת רם",
  נתניה: "נתניה – שבילי אופניים עירוניים",
  "חיפה-העירונית": "חיפה – שבילי אופניים עירוניים",
  "עמק-המעיינות-משפחות-מפעלי-המים-והגשר-התלוי": "עמק המעיינות – מפעלי המים והגשר התלוי",
  "הירקון-רכיבת-קיץ": "הירקון – פתח תקווה",
  עטרת: "עטרת – אריאל",
  "רמת-הגולן": "רמת הגולן – דרכי הבזלת",
};

// ---------------------------------------------------------------------------------------------
// area rules — explicit, evidence-based, deliberately few. Anything else stays as curated.
// ---------------------------------------------------------------------------------------------

/** The source site's own region label for each area (from the 1009 files), kept in step when an
 *  area changes so the two never disagree. */
const SITE_REGION: Record<string, string> = {
  "ירושלים והרים": "ירושלים והרי יהודה",
  "דרום הר חברון": "ירושלים והרי יהודה",
  "גלבוע ועמקים": "כרמל, רמות מנשה והעמקים",
  "כרמל / רמות מנשה": "כרמל, רמות מנשה והעמקים",
  שרון: "שרון",
  "שפלת יהודה": "מרכז ושפלה",
  "מרכז / שפלה": "מרכז ושפלה",
  "נגב מערבי": "דרום — נגב ומכתשים",
  "נגב / מכתשים": "דרום — נגב ומכתשים",
  "נגב צפוני": "דרום — נגב ומכתשים",
  "מדבר יהודה ובקעת ים המלח": "מדבר יהודה וים המלח",
  "ערבה / אילת": "ערבה ואילת",
};

interface AreaFix {
  to: string;
  rule: string;
}

function areaFix(area: string, lat: number, lon: number): AreaFix | null {
  const A = area.replace(/\s+/g, " ").trim();
  if (A === "גליל תחתון") {
    if (lat < 32.62 && lon >= 35.1) {
      return { to: "גלבוע ועמקים", rule: "Beit She'an / Jezreel / Gilboa valleys are not the Lower Galilee" };
    }
    if (lat < 32.65 && lon < 35.1) {
      return { to: "כרמל / רמות מנשה", rule: "Ramot Menashe / Carmel foothills, not the Lower Galilee" };
    }
  }
  if (A === "ערבה / אילת" && lat >= 30.3) {
    if (lat >= 31.3 && lon < 35.0) return { to: "נגב צפוני", rule: "north Negev (Lahav/Beersheba latitude), not the Arava" };
    if (lat >= 30.9 && lon >= 35.15) return { to: "מדבר יהודה ובקעת ים המלח", rule: "Dead Sea / Arad / Neve Zohar, not the Arava" };
    if (lon < 34.98) return { to: lon < 34.7 ? "נגב מערבי" : "נגב / מכתשים", rule: "Negev highlands (Ramon / Sde Boker), west of the Arava" };
    if (lat >= 30.95) return { to: "נגב / מכתשים", rule: "Negev craters (Yeruham / Dimona), not the Arava" };
  }
  if (A === "דרום הר חברון" && lat >= 31.36 && lon <= 34.95) {
    return { to: "נגב צפוני", rule: "Lehavim / Ruhama are in the north Negev, not the South Hebron hills" };
  }
  if (A === "נגב צפוני" && lat > 32) {
    return { to: "גלבוע ועמקים", rule: "coordinates are at Migdal HaEmek (Jezreel valley), not the Negev" };
  }
  if (A === "מרכז / שפלה" && lat >= 32.35) {
    return lat < 32.5
      ? { to: "שרון", rule: "Hadera latitude is the north Sharon, not the Center" }
      : { to: "כרמל / רמות מנשה", rule: "Zikhron / Binyamina / Atlit / Haifa are Carmel-side, not the Center" };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// raw-text JSON edits: change ONE top-level value in place so the diff stays one line
// ---------------------------------------------------------------------------------------------

function setTopLevel(raw: string, key: string, literal: string): string | null {
  const re = new RegExp(`^(\\s*"${key}"\\s*:\\s*)(.*?)(,?)(\\r?)$`, "m");
  const m = raw.match(re);
  if (!m) return null;
  return raw.replace(re, (_all, a, _old, comma, cr) => `${a}${literal}${comma}${cr}`);
}

interface Fix {
  folder: string;
  field: string;
  old: string;
  next: string;
  reason: string;
  confidence: string;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function main() {
  const snapshot = loadSnapshot();
  const curationNames = loadCurationNames();
  const suggestions = loadSuggestions();
  const folders = readdirSync(TRACKS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const fixes: Fix[] = [];
  const edited = new Map<string, string>();
  const unresolved: string[] = [];
  const ruleCounts: Record<string, number> = {};

  for (const folder of folders) {
    const file = path.join(TRACKS, folder, "metadata.json");
    let raw = readFileSync(file, "utf8");
    const meta = JSON.parse(raw) as Record<string, unknown>;
    const snap = snapshot.get(folder);
    const log = (f: Omit<Fix, "folder">) => fixes.push({ folder, ...f });
    const setString = (field: string, key: string, value: string, why: Omit<Fix, "folder" | "field" | "old" | "next">) => {
      const updated = setTopLevel(raw, key, JSON.stringify(value));
      if (updated === null) {
        unresolved.push(`${folder}: cannot edit "${key}" in place`);
        return;
      }
      log({ field, old: String(meta[key] ?? ""), next: value, ...why });
      raw = updated;
      meta[key] = value;
    };

    // 1. REPAIR — only where the snapshot AND (for names) the original curation report agree.
    if (snap) {
      // Skipped where step 2 is about to replace the name anyway. The curation report is NOT an
      // independent check for every folder (the same process rewrote some of its rows), so the
      // snapshot taken before the damage is the reference.
      const renamedBelow = suggestions.has(folder) && folder in NAME_OVERRIDES !== true
        ? suggestions.get(folder)?.name !== suggestions.get(folder)?.current
        : folder in NAME_OVERRIDES && NAME_OVERRIDES[folder] !== null;
      if (typeof meta.name === "string" && meta.name !== snap.name && !renamedBelow) {
        const report = curationNames.get(folder);
        const agrees = report !== undefined && report.normalize("NFC") === snap.name.normalize("NFC");
        setString("name", "name", snap.name, {
          reason: `REPAIR: name corrupted by a concurrent process${agrees ? "" : " (snapshot only; the curation report row is corrupted too)"}`,
          confidence: agrees ? "high" : "medium",
        });
      }
      if (typeof meta.description === "string" && meta.description !== snap.desc) {
        setString("description", "description", snap.desc, { reason: "REPAIR: description corrupted by a concurrent process", confidence: "high" });
      }
      if ((meta.gpx_internal_name ?? null) !== (snap.gi ?? null) && snap.gi) {
        setString("gpx_internal_name", "gpx_internal_name", snap.gi, { reason: "REPAIR: GPX internal name corrupted by a concurrent process", confidence: "high" });
      }
    }

    // 2. NAMES
    const sug = suggestions.get(folder);
    if (sug) {
      let target: string | null;
      if (folder in NAME_OVERRIDES) target = NAME_OVERRIDES[folder];
      else target = sug.name;
      if (target !== null && /[()]/.test(target)) unresolved.push(`${folder}: suggestion has parentheses and no override: ${target}`);
      else if (target !== null && target.normalize("NFC") !== String(meta.name).normalize("NFC")) {
        setString("name", "name", target, { reason: "NAME: non-geographic name replaced (see suspicious_names_report.csv)", confidence: sug.confidence });
      }
    }

    // 3. AREAS
    const lat = Number(meta.latitude);
    const lon = Number(meta.longitude);
    if (typeof meta.area === "string" && Number.isFinite(lat) && Number.isFinite(lon)) {
      const fix = areaFix(meta.area, lat, lon);
      if (fix) {
        ruleCounts[`${meta.area} → ${fix.to}`] = (ruleCounts[`${meta.area} → ${fix.to}`] ?? 0) + 1;
        setString("area", "area", fix.to, { reason: `AREA: ${fix.rule}`, confidence: "high" });
        const site = SITE_REGION[fix.to];
        if (site && meta.region !== site) {
          setString("region", "region", site, { reason: "AREA: site region kept in step with the corrected area", confidence: "high" });
        }
      }
    }

    // 4. CLIMB
    const climb = typeof meta.climb_m === "string" ? Number(meta.climb_m) : (meta.climb_m as number | null);
    if (typeof climb === "number" && Number.isFinite(climb) && climb < 0) {
      const gpxName = readdirSync(path.join(TRACKS, folder)).find((f) => /\.gpx$/i.test(f));
      const parsed = gpxName ? parseGpx(readFileSync(path.join(TRACKS, folder, gpxName), "utf8")) : null;
      const ascent = parsed ? ascentFromElevations(parsed.points.map((p) => p.ele)) : { ascentM: null };
      const updated = setTopLevel(raw, "climb_m", ascent.ascentM === null ? "null" : String(ascent.ascentM));
      if (updated === null) unresolved.push(`${folder}: cannot edit climb_m in place`);
      else {
        log({
          field: "climb_m",
          old: String(climb),
          next: ascent.ascentM === null ? "null" : String(ascent.ascentM),
          reason:
            ascent.ascentM === null
              ? "CLIMB: negative value is invalid and the GPX has no reliable elevation — unknown"
              : "CLIMB: negative value is invalid — positive ascent computed from the GPX elevation (5 m hysteresis, same as the app)",
          confidence: ascent.ascentM === null ? "medium" : "high",
        });
        raw = updated;
      }
    }

    if (raw !== readFileSync(file, "utf8")) edited.set(folder, raw);
    JSON.parse(raw); // an edit must never leave invalid JSON
  }

  // ---- report ----
  const by = (p: string) => fixes.filter((f) => f.reason.startsWith(p));
  console.log(`mode: ${APPLY ? "APPLY" : "dry-run"}   folders: ${folders.length}   files to change: ${edited.size}`);
  console.log(`REPAIR ${by("REPAIR").length}  NAME ${by("NAME").length}  AREA ${by("AREA: ").filter((f) => f.field === "area").length}  CLIMB ${by("CLIMB").length}`);
  console.log("area rules fired:", JSON.stringify(ruleCounts, null, 1));
  for (const f of by("CLIMB")) console.log(`  climb ${f.folder}: ${f.old} -> ${f.next}`);
  if (unresolved.length) {
    console.log(`UNRESOLVED (${unresolved.length}):`);
    for (const u of unresolved) console.log("  " + u);
  }
  if (!APPLY) return;
  if (unresolved.length) throw new Error("refusing to apply with unresolved items");

  // ---- write: backup first, then edit, then manifest ----
  if (existsSync(BACKUP_DIR)) throw new Error(`${BACKUP_DIR} already exists — refusing to overwrite a backup`);
  for (const folder of folders) {
    mkdirSync(path.join(BACKUP_DIR, folder), { recursive: true });
    cpSync(path.join(TRACKS, folder, "metadata.json"), path.join(BACKUP_DIR, folder, "metadata.json"));
  }
  for (const [folder, raw] of edited) writeFileSync(path.join(TRACKS, folder, "metadata.json"), raw);

  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  writeFileSync(
    FIXES_CSV,
    `\uFEFF${["folder,field,old_value,new_value,reason,confidence", ...fixes.map((f) => [f.folder, f.field, f.old, f.next, f.reason, f.confidence].map(esc).join(","))].join("\r\n")}\r\n`,
  );
  const manifest: Record<string, string> = {};
  for (const folder of folders) manifest[folder] = sha(readFileSync(path.join(TRACKS, folder, "metadata.json")));
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(`backup: ${BACKUP_DIR}\nlog:    ${FIXES_CSV}\nmanifest: ${MANIFEST}`);
}

main();
