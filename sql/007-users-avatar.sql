-- 007-users-avatar.sql — the Google profile picture, shown next to a rider in lists.
-- Already present in 001-init.sql; this file exists for the database that was created by
-- Prisma before the column was added.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500);
