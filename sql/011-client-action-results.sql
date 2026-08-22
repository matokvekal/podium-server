-- 011-client-action-results.sql — let a de-duplicated retry answer with the ORIGINAL result.
--
-- sql/006-client-actions.sql described the behaviour ("the server records it here and answers
-- a repeat with 409 carrying the original result") but gave the table nowhere to keep that
-- result. The client's apiMutate reads `body.data` out of the 409 and treats it as the
-- action's return value, so without these two columns a replayed action succeeds and hands
-- the rider `undefined`.
--
-- Purged on the same schedule as the rest of client_actions — a replay window is short by
-- nature, so this never becomes a second copy of the database.
--
-- Safe to run on the live database: both statements are additive.

ALTER TABLE client_actions
    ADD COLUMN IF NOT EXISTS response_status INT,
    ADD COLUMN IF NOT EXISTS response_body   JSONB;
