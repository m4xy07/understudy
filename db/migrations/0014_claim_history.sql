-- 0014_claim_history: role-scoped reads of claim_events, for the claim history view.
-- Contract: docs/ARCHITECTURE.md section 5.
--
-- claim_events had no reader grant: only the admin path read it. The history view reads it inside
-- withRole(), so us_reader gets SELECT here, behind a policy that asks the claims table: an event
-- exists for a role only when the claim it belongs to does. The subquery runs as us_reader, so the
-- claims policy (us_can_see on role_set and flag_role_set) decides, and the two cannot drift apart.
-- No role key, no new function. The table stays append-only (0001: trigger and revoked grants).
GRANT SELECT ON claim_events TO us_reader;

ALTER TABLE claim_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_events FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS us_reader_select ON claim_events;
  CREATE POLICY us_reader_select ON claim_events FOR SELECT TO us_reader USING (
    workspace_id = us_claim('workspace_id')::uuid
    AND EXISTS (
      SELECT 1 FROM claims c
      WHERE c.workspace_id = claim_events.workspace_id AND c.id = claim_events.claim_id));
  DROP POLICY IF EXISTS us_admin_all ON claim_events;
  EXECUTE format('CREATE POLICY us_admin_all ON claim_events FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
