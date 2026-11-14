-- 0006_packs: a workspace knows its setting pack; no role key lives in the schema any more.
-- Contract: docs/ARCHITECTURE.md sections 1, 3 and 4 (Round 3 foundation pass).
--
--   * workspaces.pack_id loses its default: the app always supplies the pack id.
--   * workspaces.approver_role and leaver_role are copied from the pack when the workspace is
--     created. The database uses them to keep enforcing "only the approver approves a snapshot,
--     and the leaver never does" without naming a role.
--   * pack_id, approver_role and leaver_role can never change: a workspace never changes setting.
--   * snapshots: the literal approver check from 0001 is replaced by a trigger that reads the
--     workspace's approver_role and leaver_role.
--   * Shared enum checks widened once for all three Round 3 improvements:
--       sources.kind and segments.kind  + 'finding'
--       claims.trust                    + 'successor_found'
--       claims.origin                   + 'neighbour_answer', 'trace', 'successor_finding'
--   * role_holders: which person records hold which role (filled from the pack's roleHolders).
-- RLS is unchanged: role_set stays text[] and policies compare text, so a new pack needs no migration.
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- Workspaces: pack id without a default, approver and leaver role per workspace
-- ---------------------------------------------------------------------------
ALTER TABLE workspaces ALTER COLUMN pack_id DROP DEFAULT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS approver_role text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS leaver_role   text;

-- The guard below would refuse the backfill on a re-run, so it is dropped first.
DROP TRIGGER IF EXISTS workspaces_setting_fixed ON workspaces;

-- Backfill: every workspace created before this migration used the one pack that existed then.
UPDATE workspaces SET approver_role = 'president', leaver_role = 'leaver' WHERE pack_id = 'club' AND approver_role IS NULL;

ALTER TABLE workspaces ALTER COLUMN approver_role SET NOT NULL;
ALTER TABLE workspaces ALTER COLUMN leaver_role   SET NOT NULL;

ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_roles_chk;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_roles_chk CHECK (
  approver_role ~ '^[a-z][a-z0-9_]{1,31}$'
  AND leaver_role ~ '^[a-z][a-z0-9_]{1,31}$'
  AND approver_role <> leaver_role
  AND pack_id ~ '^[a-z][a-z0-9_-]{0,31}$'
);

CREATE OR REPLACE FUNCTION us_setting_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pack_id IS DISTINCT FROM OLD.pack_id
     OR NEW.approver_role IS DISTINCT FROM OLD.approver_role
     OR NEW.leaver_role IS DISTINCT FROM OLD.leaver_role THEN
    RAISE EXCEPTION 'a workspace never changes its setting pack, approver role or leaver role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workspaces_setting_fixed BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION us_setting_fixed();

-- ---------------------------------------------------------------------------
-- Snapshots: approved by the workspace's approver role, never by its leaver role
-- ---------------------------------------------------------------------------
ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS snapshots_approved_by_check;

CREATE OR REPLACE FUNCTION us_check_approver() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  w record;
BEGIN
  SELECT approver_role, leaver_role INTO w FROM workspaces WHERE id = NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'snapshot for an unknown workspace' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.approved_by = w.leaver_role THEN
    RAISE EXCEPTION 'the leaver can never approve a snapshot' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.approved_by IS DISTINCT FROM w.approver_role THEN
    RAISE EXCEPTION 'only the approver role of this workspace can approve a snapshot' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS snapshots_check_approver ON snapshots;
CREATE TRIGGER snapshots_check_approver BEFORE INSERT OR UPDATE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION us_check_approver();

-- ---------------------------------------------------------------------------
-- Shared enum checks, widened once
-- ---------------------------------------------------------------------------
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check
  CHECK (kind IN ('whatsapp','slack','github','tasks_csv','markdown','ics','interview','finding'));

ALTER TABLE segments DROP CONSTRAINT IF EXISTS segments_kind_check;
ALTER TABLE segments ADD CONSTRAINT segments_kind_check
  CHECK (kind IN ('message','commit','file','task','note','event','answer','finding'));

ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_trust_check;
ALTER TABLE claims ADD CONSTRAINT claims_trust_check
  CHECK (trust IN ('from_record','corroborated','leaver_said','successor_found','second_hand','inferred','ranked_options'));

ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_origin_check;
ALTER TABLE claims ADD CONSTRAINT claims_origin_check
  CHECK (origin IN ('extracted','structured','leaver_answer','neighbour_answer','trace','successor_finding'));

-- ---------------------------------------------------------------------------
-- role_holders: which person records hold which role
-- ---------------------------------------------------------------------------
-- One human can have several person records (a chat export and a code host), so a role can list
-- several. `source` says who stated it: the pack (roleHolders) or the approver in the app.
-- Admin path only: no grant to us_reader, so no RLS policy is needed.
CREATE TABLE IF NOT EXISTS role_holders (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_key      text NOT NULL CHECK (role_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  person_id     text NOT NULL,
  source        text NOT NULL DEFAULT 'pack' CHECK (source IN ('pack', 'approver')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, role_key, person_id)
);
CREATE INDEX IF NOT EXISTS role_holders_person ON role_holders (workspace_id, person_id);

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON role_holders FROM %I', r);
    END IF;
  END LOOP;
END $$;
