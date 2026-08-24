// Orphaned user-upload sweeper.
//
// Files become orphans in three ordinary ways:
//   * a replacement whose unlink failed (the service deletes best-effort, on purpose — see
//     services/user-image.service.ts for why the request must not fail on it)
//   * a user row deleted while their directory stayed behind
//   * a file written by a request that died between the write and the UPDATE
//
// It removes ONLY files under UPLOADS_DIR/users/ that no users row points at. It never
// touches assets/presets/ — that art ships with the code, is shared by every rider who
// picked it, and belongs to no user.
//
// Usage:
//   node scripts/cleanup-user-uploads.mjs            # dry run, lists what it would remove
//   node scripts/cleanup-user-uploads.mjs --delete   # actually remove them
//
// Safe to run on a live server; suitable for cron.

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const DELETE = process.argv.includes("--delete");
const UPLOADS_DIR = path.resolve(
  process.env.UPLOADS_DIR?.trim() || path.join(process.cwd(), "var/uploads"),
);
const USERS_ROOT = path.join(UPLOADS_DIR, "users");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

/** Everything the database currently points at, as "users/{id}/{file}" references. */
async function referencedRefs(client) {
  const { rows } = await client.query(
    `SELECT avatar_value AS ref FROM users WHERE avatar_type = 'upload' AND avatar_value IS NOT NULL
     UNION
     SELECT cover_value  AS ref FROM users WHERE cover_type  = 'upload' AND cover_value  IS NOT NULL`,
  );
  return new Set(rows.map((row) => row.ref));
}

async function existingUserIds(client) {
  const { rows } = await client.query("SELECT id FROM users");
  return new Set(rows.map((row) => String(row.id)));
}

async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const referenced = await referencedRefs(client);
  const userIds = await existingUserIds(client);

  const orphans = [];
  let kept = 0;

  for (const dirent of await listDirs(USERS_ROOT)) {
    if (!dirent.isDirectory()) continue;
    const userId = dirent.name;
    const userDir = path.join(USERS_ROOT, userId);
    const userExists = userIds.has(userId);

    for (const file of await listDirs(userDir)) {
      if (!file.isFile()) continue;
      const ref = `users/${userId}/${file.name}`;
      // A file survives only if a live user row names it. A directory for a user that no
      // longer exists is orphaned in full.
      if (userExists && referenced.has(ref)) {
        kept += 1;
        continue;
      }
      const { size } = await stat(path.join(userDir, file.name));
      orphans.push({ ref, size, reason: userExists ? "unreferenced" : "user deleted" });
    }
  }

  const totalKb = Math.round(orphans.reduce((sum, o) => sum + o.size, 0) / 1024);
  console.log(`upload root : ${UPLOADS_DIR}`);
  console.log(`referenced  : ${kept} file(s) kept`);
  console.log(`orphaned    : ${orphans.length} file(s), ${totalKb} KB`);

  for (const orphan of orphans) {
    console.log(`  ${DELETE ? "removing" : "would remove"}  ${orphan.ref}  (${orphan.reason})`);
    if (DELETE) await rm(path.join(UPLOADS_DIR, orphan.ref), { force: true });
  }

  if (!DELETE && orphans.length > 0) {
    console.log("\nDry run. Re-run with --delete to remove them.");
  }
} finally {
  await client.end();
}
