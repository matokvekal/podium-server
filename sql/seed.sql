-- seed.sql — two example events for local development.
--
-- Replaces the old prisma/seed.ts. Run it by hand against a development database only:
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/seed.sql
--
-- Codes here are short and memorable rather than in the real DDMMYYYY + letter format, so
-- they are obviously test data.

INSERT INTO events (code, name, type, requires_bib, is_active)
VALUES ('74291', 'Saturday Gravel Ride', 'RIDE', FALSE, TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO events (code, name, type, requires_bib, is_active)
VALUES ('10001', 'Gravel Championship', 'RACE', TRUE, TRUE)
ON CONFLICT (code) DO NOTHING;

SELECT code, name, type, requires_bib FROM events WHERE code IN ('74291', '10001');
