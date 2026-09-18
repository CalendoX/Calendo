-- Database-level guarantee that an interviewer can never hold two active interviews whose
-- meeting times overlap, regardless of application bugs or concurrent requests.
--
-- The application additionally serialises bookings per interviewer (pg_advisory_xact_lock)
-- and enforces buffer rules inside that lock; this constraint is the last line of defence.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "interviews"
  ADD CONSTRAINT "interviews_no_overlapping_active"
  EXCLUDE USING gist (
    "host_user_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  )
  WHERE ("status" IN ('scheduled', 'rescheduled'));
