-- 0012_grants: close what the Supabase Data API roles (anon, authenticated) could still reach.
-- Understudy never uses the Data API: every read and write goes through the app's own database
-- user (admin path) or through `SET LOCAL ROLE us_reader` (role-scoped reads, withRole()).
--
--   * Tables: REVOKE ALL on every table and sequence in public from anon and authenticated.
--     0001 did this once, for the tables that existed then; tables created by 0006 to 0011
--     (findings, snapshot_changes, action_leases, model_spend, ...) got Supabase's default grants.
--   * Default privileges: objects this user creates in public later get no grant for those roles.
--   * RLS: snapshot_changes, action_leases and model_spend get ENABLE + FORCE row level security
--     with the admin policy only (none of them carries a role set, and us_reader has no grant on
--     them), so a role that is ever granted the table by mistake still reads nothing.
--   * Functions: EXECUTE is revoked from PUBLIC, anon and authenticated on every function of this
--     schema (REVOKE ... FROM PUBLIC alone does not remove Supabase's direct grants). us_reader
--     keeps exactly the functions the role-scoped path calls; the migration user keeps all.
--   * Every SECURITY DEFINER function has a fixed search_path.
--   * count_withheld() refuses another workspace than the one in the request claims, like
--     claim_meta() and count_limited().
-- Works on plain Postgres, where anon and authenticated do not exist. Idempotent.
-- scripts/migrate.ts repeats the blanket revoke after every run, so later tables are covered too.

-- ---------------------------------------------------------------------------
-- count_withheld: same signature and result; now checks the workspace of the request claims.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION count_withheld(ws uuid, role text, section text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH latest AS (
    SELECT id FROM snapshots WHERE workspace_id = ws ORDER BY version DESC LIMIT 1
  )
  SELECT count(*)::integer
  FROM snapshot_claims sc
  JOIN latest l ON l.id = sc.snapshot_id
  WHERE sc.workspace_id = ws
    AND (us_claim('workspace_id') IS NULL OR us_claim('workspace_id')::uuid = ws)
    AND NOT us_can_see(role, sc.role_set, sc.flag_role_set)
    AND (
      section IS NULL OR section = 'all'
      OR sc.attribute = ANY(string_to_array(replace(section, ' ', ''), ','))
    )
$$;

-- ---------------------------------------------------------------------------
-- Row level security on the admin-only tables that had none
-- ---------------------------------------------------------------------------
ALTER TABLE snapshot_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshot_changes FORCE  ROW LEVEL SECURITY;
ALTER TABLE action_leases    ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_leases    FORCE  ROW LEVEL SECURITY;
ALTER TABLE model_spend      ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_spend      FORCE  ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['snapshot_changes', 'action_leases', 'model_spend'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS us_admin_all ON %I', t);
    EXECUTE format('CREATE POLICY us_admin_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Functions: fixed search_path on SECURITY DEFINER, no EXECUTE for PUBLIC
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f record;
BEGIN
  -- Functions of this schema only: never one that belongs to an extension.
  FOR f IN
    SELECT p.oid::regprocedure AS sig, p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    IF f.prosecdef THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.sig);
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f.sig, current_user);
  END LOOP;
END $$;

-- What the role-scoped path (us_reader inside withRole) calls: the claims reader and the two
-- helpers the RLS policies use, and the four metadata functions. Nothing else.
GRANT EXECUTE ON FUNCTION us_claim(text) TO us_reader;
GRANT EXECUTE ON FUNCTION us_can_see(text, text[], text[]) TO us_reader;
GRANT EXECUTE ON FUNCTION us_segment_head(uuid, text) TO us_reader;
GRANT EXECUTE ON FUNCTION count_withheld(uuid, text, text) TO us_reader;
GRANT EXECUTE ON FUNCTION count_limited(uuid, text) TO us_reader;
GRANT EXECUTE ON FUNCTION claim_meta(uuid) TO us_reader;

-- ---------------------------------------------------------------------------
-- anon / authenticated (Supabase): nothing in public, now or by default
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r text;
  f record;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      FOR f IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f.sig, r);
      END LOOP;
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
