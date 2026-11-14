-- 0013_contact_counters.sql
-- Contact placeholder numbers for text typed into the app (a leaver's answer, a neighbour's
-- answer, a successor finding) were taken from count(*) of the contacts table, read outside the
-- insert: two saves at the same moment could get the same number, and the second contact was then
-- dropped by ON CONFLICT DO NOTHING (its placeholder resolved to the first one's value).
-- One counter row per workspace, advanced in one atomic statement, gives each save its own range.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS contact_counters (
  workspace_id  uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  next          integer NOT NULL DEFAULT 0
);

-- Admin only, like action_leases and model_spend (0012): no role-scoped reader touches it.
ALTER TABLE contact_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_counters FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS us_admin_all ON contact_counters;
  EXECUTE format('CREATE POLICY us_admin_all ON contact_counters FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON contact_counters FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON contact_counters FROM authenticated;
  END IF;
END $$;
