-- 0005_relay: Review and Handover (Relay) additions on top of 0001_core.
-- Contract: docs/ARCHITECTURE.md section 4 "Review and Handover" and section 5.
--
--   * snapshot_claims keeps the reviewed value, state, review and importance of each claim as
--     approved, so the per-role compile reads only the frozen snapshot (under RLS), never the
--     live claims table.
--   * acknowledgements records whether every visible read-back item matched (append-only stays
--     enforced by the 0001 trigger; this only adds a column with a default).
--   * Indexes for the history and acknowledgement lists.
-- Idempotent: safe to re-run.

ALTER TABLE snapshot_claims ADD COLUMN IF NOT EXISTS value      text;
ALTER TABLE snapshot_claims ADD COLUMN IF NOT EXISTS state      text NOT NULL DEFAULT 'active';
ALTER TABLE snapshot_claims ADD COLUMN IF NOT EXISTS review     text NOT NULL DEFAULT 'approved';
ALTER TABLE snapshot_claims ADD COLUMN IF NOT EXISTS importance text NOT NULL DEFAULT 'normal';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_claims_review_chk') THEN
    ALTER TABLE snapshot_claims ADD CONSTRAINT snapshot_claims_review_chk
      CHECK (review IN ('approved', 'edited'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_claims_state_chk') THEN
    ALTER TABLE snapshot_claims ADD CONSTRAINT snapshot_claims_state_chk
      CHECK (state IN ('active', 'conflicting'));
  END IF;
END $$;

ALTER TABLE acknowledgements ADD COLUMN IF NOT EXISTS all_matched boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS acknowledgements_ws ON acknowledgements (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS snapshot_claims_snap ON snapshot_claims (workspace_id, snapshot_id);
