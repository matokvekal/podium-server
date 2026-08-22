-- 010-drop-one-live-per-owner.sql — remove the one-live-event-per-owner unique index.
--
-- Product now allows up to N (currently 2) simultaneous live events per owner, and higher
-- limits for paid organizers later. A plain unique index can only express "at most 1", so
-- that limit moves to the server (a count-based check in a transaction, in
-- event.service.ts's changeEventStatus) instead of the database.
--
-- Safe to run on the live database: this only drops an index, no data or columns are affected.

DROP INDEX IF EXISTS idx_events_one_live_per_owner;
