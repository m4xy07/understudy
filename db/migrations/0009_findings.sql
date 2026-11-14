-- Living handover (Round 3, improvement 3). docs/round3/specs/03_living_handover_second_setting.md B5.
--
-- findings          one row per thing the successor learned after release. The row is the flow
--                   record only: it holds no answer, note or link text. Content lives in the
--                   finding segment, under the same row-level security as every other segment.
-- snapshot_changes  one row per snapshot: what changed against the previous version and why.
--                   Ids, numbers and fixed sentences only: no statement, no value. Statements are
--                   joined from snapshot_claims inside withRole, so RLS decides what a role reads.
-- claim_meta(ws)    replaced (same columns): a finding that is not approved is evidence for nobody,
--                   so it can never make a check read "Restricted" for another role.

CREATE TABLE IF NOT EXISTS findings (
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id                     text NOT NULL,                 -- fnd_ + 12 hex
  responsibility_id      text NOT NULL,
  check_key              text NOT NULL,
  segment_id             text NOT NULL,                 -- the evidence
  attachment_segment_id  text,                          -- optional file, stored inside the finding
  claim_id               text NOT NULL,
  recorded_by            text NOT NULL,                 -- role key
  status                 text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','approved','rejected','withdrawn')),
  role_set               text[] NOT NULL,               -- same as the segment and the claim
  snapshot_id            text,                          -- set when a snapshot carries the finding
  score_delta            text,                          -- numbers and trust labels only
  review_note            text,                          -- the approver's reason
  created_at             timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS findings_gap ON findings (workspace_id, responsibility_id, check_key);
-- One finding waiting for review per gap: a second save for the same gap is refused.
CREATE UNIQUE INDEX IF NOT EXISTS findings_one_pending
  ON findings (workspace_id, responsibility_id, check_key) WHERE status = 'pending';

GRANT SELECT ON findings TO us_reader;
ALTER TABLE findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings FORCE  ROW LEVEL SECURITY;
DO $$
BEGIN
  DROP POLICY IF EXISTS us_reader_select ON findings;
  CREATE POLICY us_reader_select ON findings FOR SELECT TO us_reader USING (
    workspace_id = us_claim('workspace_id')::uuid AND us_claim('role_key') = ANY(role_set));
  DROP POLICY IF EXISTS us_admin_all ON findings;
  EXECUTE format('CREATE POLICY us_admin_all ON findings FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

CREATE TABLE IF NOT EXISTS snapshot_changes (
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id       text NOT NULL,
  from_snapshot_id  text,                                -- null for the first version
  test_run_id       text,                                -- the successor's run this snapshot was built on
  diff              jsonb NOT NULL,                      -- SnapshotDiff: claim ids, scores, plan flag
  gaps_closed       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ responsibilityId, checkKey, blocking, claimIds }]
  gaps_opened       jsonb NOT NULL DEFAULT '[]'::jsonb,
  claim_changes     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ claimId, kind, from?, to? }] trust values only
  delta_text        text NOT NULL DEFAULT '',            -- "B 5 → 4: ... · C 62% → 66% · K 88% → 84%"
  lines             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { b, c, k }: fixed sentences chosen by code
  cause             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { type: first | finding | manual, findingIds: [] }
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, snapshot_id),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES snapshots(workspace_id, id) ON DELETE CASCADE
);

-- Append-only, like the snapshot it describes.
REVOKE UPDATE, DELETE, TRUNCATE ON snapshot_changes FROM PUBLIC;
DROP TRIGGER IF EXISTS snapshot_changes_immutable ON snapshot_changes;
CREATE TRIGGER snapshot_changes_immutable BEFORE UPDATE ON snapshot_changes
  FOR EACH ROW EXECUTE FUNCTION us_immutable();

-- A finding counts as evidence only once the approver has let it in.
CREATE OR REPLACE FUNCTION claim_meta(ws uuid)
RETURNS TABLE (id text, entity text, attribute text, state text, trust text, role_set text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.entity, c.attribute, c.state, c.trust, c.role_set
  FROM claims c
  WHERE c.workspace_id = ws
    AND (us_claim('workspace_id') IS NULL OR us_claim('workspace_id')::uuid = ws)
    AND NOT (c.origin = 'successor_finding' AND c.review NOT IN ('approved', 'edited'))
  ORDER BY c.id
$$;
REVOKE ALL ON FUNCTION claim_meta(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_meta(uuid) TO us_reader;
DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION claim_meta(uuid) TO %I', current_user);
END $$;
