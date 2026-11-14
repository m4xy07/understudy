-- 0010_fixes.sql: Round 2 fixes that keep the app standing under abuse.
--   * runs: a lease so two pipeline runs of one workspace can never overlap, a heartbeat, a slice
--     counter and a cursor so a run that needs more than one function invocation continues where
--     it stopped (status 'paused' between slices).
--   * action_leases: one holder at a time per (workspace, key). Makes a repeated submit (double
--     click, second tab) a no-op, and marks background work the page is waiting for.
--   * model_spend: live model calls per workspace per day (the spend cap).
--   * workspaces: last_active_at and access_mode ('open' today; 'invite' is reserved for locked
--     workspaces), and purge_stale_workspaces(), the cleanup rule that never deletes a workspace
--     that is locked or has an approved snapshot.
-- Additive and idempotent: the Round 2 build still runs against this schema.

-- ---------------------------------------------------------------------------
-- Runs: lease, heartbeat, slices, cursor, paused
-- ---------------------------------------------------------------------------
ALTER TABLE runs ADD COLUMN IF NOT EXISTS lease_until  timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS slices       integer NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cursor       jsonb   NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN ('running', 'paused', 'done', 'failed'));

-- Runs left "running" by a function that was killed, and extra live runs of one workspace from
-- before the lease existed: close them, keeping only the newest live run per workspace.
UPDATE runs r SET status = 'failed', finished_at = now(),
  error = coalesce(r.error, 'This run was interrupted before it finished. Press Run again.')
WHERE r.status IN ('running', 'paused')
  AND (r.started_at < now() - interval '15 minutes'
       OR EXISTS (SELECT 1 FROM runs n WHERE n.workspace_id = r.workspace_id AND n.status IN ('running', 'paused')
                  AND (n.started_at, n.id) > (r.started_at, r.id)));

-- At most one live run per workspace: the database refuses a second one.
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_live ON runs (workspace_id) WHERE status IN ('running', 'paused');

-- ---------------------------------------------------------------------------
-- Action leases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_leases (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key           text NOT NULL,
  holder        uuid NOT NULL,
  generation    integer NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- ---------------------------------------------------------------------------
-- Live model calls per workspace per day
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_spend (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day           date NOT NULL DEFAULT current_date,
  calls         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
CREATE INDEX IF NOT EXISTS model_spend_day ON model_spend (day);

-- ---------------------------------------------------------------------------
-- Cleanup of old workspaces
-- ---------------------------------------------------------------------------
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS last_active_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS access_mode    text NOT NULL DEFAULT 'open';
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_access_mode_chk;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_access_mode_chk CHECK (access_mode IN ('open', 'invite'));

-- Which workspaces the scheduled cleanup may delete:
--   demo copy                         created more than demo_days ago
--   started empty                     no activity for idle_days
--   locked (access_mode = 'invite')   never
--   has an approved snapshot          never
-- Oldest first, at most max_n per call. dry = true deletes nothing and returns the same ids.
CREATE OR REPLACE FUNCTION purge_stale_workspaces(
  demo_days integer DEFAULT 7, idle_days integer DEFAULT 14, max_n integer DEFAULT 200, dry boolean DEFAULT false
) RETURNS SETOF uuid
LANGUAGE plpgsql AS $$
DECLARE
  ids uuid[];
BEGIN
  SELECT coalesce(array_agg(id), '{}') INTO ids FROM (
    SELECT w.id FROM workspaces w
    WHERE w.access_mode = 'open'
      AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.workspace_id = w.id)
      AND ((w.kind = 'demo' AND w.created_at < now() - make_interval(days => greatest(demo_days, 1)))
        OR (w.kind <> 'demo' AND greatest(w.last_active_at, w.created_at) < now() - make_interval(days => greatest(idle_days, 1))))
    ORDER BY w.created_at
    LIMIT greatest(max_n, 0)
  ) x;
  IF NOT dry AND array_length(ids, 1) > 0 THEN
    PERFORM set_config('us.allow_purge', 'on', true);
    DELETE FROM workspaces WHERE id = ANY(ids);
    PERFORM set_config('us.allow_purge', 'off', true);
  END IF;
  RETURN QUERY SELECT unnest(ids);
END $$;

-- The age-only purge of 0001 would delete a team's approved handover: keep the name, apply the rule.
CREATE OR REPLACE FUNCTION purge_workspaces(days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM purge_stale_workspaces(days, greatest(days, 14), 100000, false);
  RETURN n;
END $$;
