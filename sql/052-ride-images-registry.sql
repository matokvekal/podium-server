-- 052-ride-images-registry.sql — turns the ride-cover picker from a compiled registry into a
-- table the System Admin can manage at runtime (/admin2026, "Ride Images" section), with no
-- code change and no deploy.
--
-- WHAT THIS REPLACES
--   sql/051's header said the registry is deliberately a source file, not a table, so that
--   adding an image never needed a migration. That tradeoff is now reversed on purpose: the
--   System Admin wants to add/retire ride-cover photos without a deploy, which requires
--   mutable state that survives a restart — exactly what a table is for. events.ride_image_key
--   itself is UNCHANGED (still a VARCHAR(64), still just a key, see sql/051); only what counts
--   as a *valid* key moves from a compiled Zod enum to this table.
--
-- SOURCE OF TRUTH
--   'static'  — a key whose picture ships as a build asset (elnino-client/public/ride-images/),
--               same as before this migration. `url` is a path RELATIVE to the client origin
--               (e.g. "/ride-images/sukkot-01.webp") — the client's own static server serves it.
--   'upload'  — a key an admin uploaded through /admin2026. The processed WebP lives under
--               RIDE_IMAGES_DIR (src/config/env.ts) on the SERVER, outside the deploy tree, and
--               `url` is an ABSOLUTE URL (PUBLIC_BASE_URL + prefix) — see
--               src/lib/ride-image-storage.ts. Same "server persists its own uploads, client
--               ships only build assets" split as UPLOADS_DIR / PROFILE_IMAGES_DIR.
--
-- `selectable` is what the Create/Edit Ride picker offers going forward; a ride that already
-- stored a since-disabled key keeps rendering it via GET /api/v1/ride-images, which returns
-- EVERY row (selectable or not) — only the picker filters on `selectable`. This is what makes
-- "Remove" safe: disabling a key can never break an existing ride.
--
-- A KEY IS STILL PERMANENT (see sql/051) — nothing here changes that. `file_name` is set only
-- for source = 'upload' (the bare filename under RIDE_IMAGES_DIR, needed to physically delete
-- an unused upload); NULL for 'static', whose file is not ours to delete.
--
-- SAFE ON LIVE DATA and safe to run more than once: CREATE TABLE IF NOT EXISTS, and the seed
-- INSERT is ON CONFLICT DO NOTHING so re-running never overwrites an admin's later edit (e.g. if
-- an admin already disabled sukkot-01 before this file happened to run again).

CREATE TABLE IF NOT EXISTS ride_images (
  key         VARCHAR(64) PRIMARY KEY,
  source      VARCHAR(16) NOT NULL CHECK (source IN ('static', 'upload')),
  selectable  BOOLEAN NOT NULL DEFAULT true,
  label       VARCHAR(60) NOT NULL,
  category    VARCHAR(32) NOT NULL DEFAULT 'generic',
  url         TEXT NOT NULL,
  -- Upload only — the bare filename under RIDE_IMAGES_DIR. NULL for 'static'.
  file_name   VARCHAR(128),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ride_images IS
  'The ride-cover registry (events.ride_image_key, sql/051). Static, build-shipped keys and admin-uploaded keys side by side; selectable = false hides a key from the picker without invalidating rides that already use it.';

-- The four keys already live and referenced by elnino-client/src/lib/ride-images.ts /
-- elnino-server/src/config/ride-images.ts as of this migration. Selectable states match what
-- those two files already say today: the Sukkot photos were retired from the picker (but the
-- files, and any ride wearing one, stay valid), tikva1 is the current live option.
INSERT INTO ride_images (key, source, selectable, label, category, url) VALUES
  ('sukkot-01', 'static', false, 'Sukkot', 'sukkot',  '/ride-images/sukkot-01.webp'),
  ('sukkot-02', 'static', false, 'Sukkot', 'sukkot',  '/ride-images/sukkot-02.webp'),
  ('sukkot-03', 'static', false, 'Sukkot', 'sukkot',  '/ride-images/sukkot-03.webp'),
  ('tikva1',    'static', true,  'Tikva',  'generic', '/ride-images/tikva1.webp')
ON CONFLICT (key) DO NOTHING;

------------------------------------------------------------------------------------------
-- Verify afterwards
------------------------------------------------------------------------------------------
--   SELECT key, source, selectable, label, category, url FROM ride_images ORDER BY created_at;
--   -- expect the 4 rows above, sukkot-01/02/03 selectable=false, tikva1 selectable=true
--
-- Roll back (safe as long as no ride references an 'upload' key that only this table remembers —
-- check first: SELECT DISTINCT ride_image_key FROM events WHERE ride_image_key IS NOT NULL;):
--   DROP TABLE IF EXISTS ride_images;
