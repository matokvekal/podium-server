-- 027-create-events-feature.sql — turn ride creation into an opt-in, granted one account at a time.
--
-- WHAT CHANGES
--   Nothing in the schema. This file only writes rows to the existing `entitlement_grants`
--   table (sql/014-authorization.sql). The behaviour change is entirely in the server code
--   that ships alongside it:
--
--     * authz/capabilities.ts  — new feature `create_events`
--     * authz/plans.ts         — organizer_pro and club include it; free does NOT
--     * authz/policy.ts        — `event:create` now requires the feature (was unconditional
--                                `true`); `event:create_private` requires it too
--     * services/event.service.ts — createEvent 403s a gated account before the weekly-limit
--                                    check
--     * controllers/user.controller.ts — GET /users/me returns `canOrganize` for the client
--
-- WHY
--   Until now every signed-in user could create rides; scale was governed only by the weekly
--   limit. The product decision is that ride creation is opened deliberately, one account at a
--   time, until a self-serve path exists.
--
--   effective "may create rides" =
--     a live organizer_pro / club plan grant   (feature comes from the plan)
--       OR
--     a live `create_events` feature grant      (this file, and the template below)
--
-- ⚠ BEHAVIOUR CHANGE FOR EXISTING FREE ORGANIZERS
--   Once the code is deployed, any free-plan account that has been creating rides can no
--   longer do so until it is granted here. This is intended — grant the accounts that should
--   keep it, using the template at the bottom.
--
-- DEPLOY ORDER
--   The server code tolerates this file not having run yet: `selectLiveGrants` already
--   swallows a missing authz table, and an ungranted account simply cannot create — which is
--   the intended end state anyway. Running this file first just avoids locking the product
--   owner out in the window between the two.
--
-- HOW TO RUN
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/027-create-events-feature.sql
--
-- SAFE ON LIVE DATA and safe to run more than once — every statement is guarded by NOT EXISTS.

------------------------------------------------------------------------------------------
-- 1. The product owner — so the deploy does not lock the account that administers the rest.
------------------------------------------------------------------------------------------
-- Email lives in auth_identities, not users (see sql/README.md "Where the live database
-- differs"). Idempotent: skipped if a live create_events grant already exists.

INSERT INTO entitlement_grants (user_id, feature, source, source_ref)
SELECT DISTINCT ai.user_id, 'create_events', 'manual', 'organizer-access:launch'
  FROM auth_identities ai
 WHERE lower(ai.email) = lower('mictavim@gmail.com')
   AND NOT EXISTS (
     SELECT 1 FROM entitlement_grants g
      WHERE g.user_id = ai.user_id
        AND g.feature = 'create_events'
        AND g.revoked_at IS NULL
   );

------------------------------------------------------------------------------------------
-- 2. Grant another account (the "I want to organize rides" requests) — TEMPLATE
------------------------------------------------------------------------------------------
-- Copy this block, set the email, run it. Idempotent, same guard as above.
--
--   INSERT INTO entitlement_grants (user_id, feature, source, source_ref)
--   SELECT DISTINCT ai.user_id, 'create_events', 'manual', 'organizer-access:<who/ticket>'
--     FROM auth_identities ai
--    WHERE lower(ai.email) = lower('someone@example.com')
--      AND NOT EXISTS (
--        SELECT 1 FROM entitlement_grants g
--         WHERE g.user_id = ai.user_id
--           AND g.feature = 'create_events'
--           AND g.revoked_at IS NULL
--      );
--
-- To REVOKE (a support decision, a refund): revoke rather than delete, so the history stays.
--
--   UPDATE entitlement_grants
--      SET revoked_at = NOW(), updated_at = NOW()
--    WHERE feature = 'create_events'
--      AND revoked_at IS NULL
--      AND user_id = (SELECT user_id FROM auth_identities
--                      WHERE lower(email) = lower('someone@example.com'));

------------------------------------------------------------------------------------------
-- Verify afterwards
------------------------------------------------------------------------------------------
--   SELECT g.user_id, ai.email, g.source, g.source_ref, g.created_at, g.revoked_at
--     FROM entitlement_grants g
--     JOIN auth_identities ai ON ai.user_id = g.user_id
--    WHERE g.feature = 'create_events'
--    ORDER BY g.created_at;
--   -- expect at least the owner, revoked_at NULL
--
-- Then run this whole file a SECOND time: it must succeed and grant nothing new.
