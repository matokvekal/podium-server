// Temporary DB inspection helper (delete after use).
import pg from "pg";

const url =
  process.env.DATABASE_URL ??
  "postgresql://elnino:elnino@191.215.39.19:5432/elnino";
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const r = await client.query(`
    SELECT
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM events) AS events,
      (SELECT count(*) FROM event_participants) AS participants,
      (SELECT count(*) FROM routes) AS routes,
      (SELECT count(*) FROM event_routes) AS event_routes
  `);
  console.log("COUNTS", JSON.stringify(r.rows));
  const u = await client.query(
    `SELECT u.id,
            ai.email,
            u.nickname,
            u.first_name,
            u.last_name,
            u.avatar_url,
            ai.provider
       FROM users u
       LEFT JOIN auth_identities ai ON ai.user_id = u.id
       ORDER BY u.id, ai.id
       LIMIT 20`
  );
  console.log("USERS", JSON.stringify(u.rows, null, 1));
  const e = await client.query(
    `SELECT id, name, status, visibility, owner_id, created_at
       FROM events ORDER BY created_at DESC LIMIT 10`
  );
  console.log("EVENTS", JSON.stringify(e.rows, null, 1));
  const er = await client.query(
    `SELECT er.event_id, er.route_id, r.distance_km, r.elevation_m, r.point_count
       FROM event_routes er JOIN routes r ON r.id = er.route_id
       ORDER BY er.created_at DESC LIMIT 10`
  );
  console.log("EVENT_ROUTES", JSON.stringify(er.rows, null, 1));
} catch (err) {
  console.error("ERR", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
