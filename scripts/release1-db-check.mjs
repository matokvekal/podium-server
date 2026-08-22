import pg from "pg";

const url =
  process.env.DATABASE_URL ??
  "postgresql://elnino:elnino@191.215.39.19:5432/elnino";

const client = new pg.Client({ connectionString: url });

async function scalar(sql) {
  const r = await client.query(sql);
  return Number(r.rows[0]?.count ?? 0);
}

async function main() {
  await client.connect();

  const duplicateActiveMemberships = await scalar(`
    SELECT COUNT(*)::text AS count
    FROM (
      SELECT event_id, user_id
      FROM event_participants
      WHERE user_id IS NOT NULL AND left_at IS NULL
      GROUP BY event_id, user_id
      HAVING COUNT(*) > 1
    ) d
  `);

  const ownerSelfMemberships = await scalar(`
    SELECT COUNT(*)::text AS count
    FROM event_participants ep
    JOIN events e ON e.id = ep.event_id
    WHERE ep.user_id IS NOT NULL
      AND ep.left_at IS NULL
      AND ep.user_id = e.owner_id
  `);

  const invalidRegistrationStatuses = await scalar(`
    SELECT COUNT(*)::text AS count
    FROM event_participants
    WHERE registration_status NOT IN ('registered', 'waiting_approval', 'approved', 'rejected')
  `);

  const blankIdentityNamesForAccountParticipants = await scalar(`
    SELECT COUNT(*)::text AS count
    FROM event_participants ep
    JOIN users u ON u.id = ep.user_id
    WHERE ep.user_id IS NOT NULL
      AND ep.left_at IS NULL
      AND NULLIF(TRIM(COALESCE(NULLIF(TRIM(u.nickname), ''), TRIM(CONCAT_WS(' ', u.first_name, u.last_name)))), '') IS NULL
  `);

  const orphanAccountParticipants = await scalar(`
    SELECT COUNT(*)::text AS count
    FROM event_participants ep
    LEFT JOIN users u ON u.id = ep.user_id
    WHERE ep.user_id IS NOT NULL
      AND u.id IS NULL
  `);

  const requiresApprovalEvents = await scalar(`
    SELECT COUNT(*)::text AS count
    FROM events
    WHERE requires_approval = TRUE
  `);

  const statusCountsRes = await client.query(`
    SELECT registration_status, COUNT(*)::text AS count
    FROM event_participants
    GROUP BY registration_status
    ORDER BY registration_status
  `);

  const statusCounts = {
    registered: 0,
    waiting_approval: 0,
    approved: 0,
    rejected: 0
  };

  for (const row of statusCountsRes.rows) {
    statusCounts[row.registration_status] = Number(row.count);
  }

  const result = {
    duplicateActiveMemberships,
    ownerSelfMemberships,
    invalidRegistrationStatuses,
    blankIdentityNamesForAccountParticipants,
    orphanAccountParticipants,
    requiresApprovalEvents,
    statusCounts
  };

  const releaseBlockingFailures = [
    duplicateActiveMemberships > 0,
    ownerSelfMemberships > 0,
    invalidRegistrationStatuses > 0,
    orphanAccountParticipants > 0
  ].some(Boolean);

  console.log("RELEASE1_DB_CHECK", JSON.stringify(result, null, 2));
  console.log(
    "RELEASE1_DB_INTEGRITY",
    releaseBlockingFailures ? "FAIL" : "PASS"
  );

  await client.end();
}

main().catch(async (err) => {
  console.error("RELEASE1_DB_CHECK_ERROR", err?.message ?? String(err));
  try {
    await client.end();
  } catch {
    // ignore
  }
  process.exitCode = 1;
});
