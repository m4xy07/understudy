-- 0008_confidentiality: content-level confidentiality (Round 3, improvement 2).
-- Contract: docs/ARCHITECTURE.md section 4a and docs/round3/specs/02_confidentiality.md.
--
--   * segments: what the content classifier found, the source role set before narrowing, and who
--     changed the visibility of this version and why. A visibility change is a new version row.
--   * Head-version rule: a reader only ever sees the newest version of a segment. Without it a
--     segment widened in version 2 and limited again in version 3 would stay readable at version 2.
--   * claims.flag_role_set and snapshot_claims.flag_role_set: when set, only these roles may see
--     the claim at all. Used for conflicts and supersessions with a side a role cannot read.
--   * us_can_see(role, role_set, flag_role_set): the one visibility test, used by the reader
--     policies, count_withheld() and claim_meta(), so the three cannot drift apart.
--   * count_limited(ws, role): how many messages in sources the role can open were limited away
--     from it. An integer only.
--   * sensitivity_checked: which head segments the current classifier version has looked at and
--     left alone (segments are immutable, so the row itself cannot be marked).
--   * probe_runs: stored runs of the wider leak check. Admin path only.
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- Segments: sensitivity fields
-- ---------------------------------------------------------------------------
ALTER TABLE segments ADD COLUMN IF NOT EXISTS sensitivity        text[] NOT NULL DEFAULT '{}';
ALTER TABLE segments ADD COLUMN IF NOT EXISTS sensitivity_stage  text;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS sensitivity_reason text;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS role_set_original  text[];
ALTER TABLE segments ADD COLUMN IF NOT EXISTS visibility_note    text;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS visibility_actor   text;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS classifier_version integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'segments_sensitivity_chk') THEN
    ALTER TABLE segments ADD CONSTRAINT segments_sensitivity_chk
      CHECK (sensitivity <@ ARRAY['finance','hr','health']::text[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'segments_sensitivity_stage_chk') THEN
    ALTER TABLE segments ADD CONSTRAINT segments_sensitivity_stage_chk
      CHECK (sensitivity_stage IS NULL OR sensitivity_stage IN ('rule','follow','model','held','manual','widened'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS segments_sensitive ON segments (workspace_id) WHERE sensitivity <> '{}';

-- ---------------------------------------------------------------------------
-- Head-version rule for readers
-- ---------------------------------------------------------------------------
-- A policy cannot query its own table (recursion), hence the SECURITY DEFINER function.
-- It returns a version number only.
CREATE OR REPLACE FUNCTION us_segment_head(ws uuid, seg text) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT max(version)::integer FROM segments WHERE workspace_id = ws AND id = seg
$$;
REVOKE ALL ON FUNCTION us_segment_head(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION us_segment_head(uuid, text) TO us_reader;
DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION us_segment_head(uuid, text) TO %I', current_user);
END $$;

DROP POLICY IF EXISTS us_reader_select ON segments;
CREATE POLICY us_reader_select ON segments FOR SELECT TO us_reader USING (
  workspace_id = us_claim('workspace_id')::uuid
  AND us_claim('role_key') = ANY(role_set)
  AND version = us_segment_head(workspace_id, id)
);

-- ---------------------------------------------------------------------------
-- Flag visibility on claims
-- ---------------------------------------------------------------------------
ALTER TABLE claims          ADD COLUMN IF NOT EXISTS flag_role_set text[];
ALTER TABLE snapshot_claims ADD COLUMN IF NOT EXISTS flag_role_set text[];

CREATE OR REPLACE FUNCTION us_can_see(role text, role_set text[], flag_role_set text[]) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT role = ANY(role_set) AND (flag_role_set IS NULL OR role = ANY(flag_role_set))
$$;
GRANT EXECUTE ON FUNCTION us_can_see(text, text[], text[]) TO us_reader;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['claims', 'snapshot_claims'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS us_reader_select ON %I', t);
    EXECUTE format(
      'CREATE POLICY us_reader_select ON %I FOR SELECT TO us_reader USING ('
      || 'workspace_id = us_claim(''workspace_id'')::uuid '
      || 'AND us_can_see(us_claim(''role_key''), role_set, flag_role_set))', t);
  END LOOP;
END $$;

-- count_withheld: same signature and meaning as 0001, now through us_can_see, so claims hidden by
-- a narrowed segment and claims hidden by a conflict flag both count. Still an integer only.
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
    AND NOT us_can_see(role, sc.role_set, sc.flag_role_set)
    AND (
      section IS NULL OR section = 'all'
      OR sc.attribute = ANY(string_to_array(replace(section, ' ', ''), ','))
    )
$$;
REVOKE ALL ON FUNCTION count_withheld(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION count_withheld(uuid, text, text) TO us_reader;

-- claim_meta: the role set it returns is now the effective one (role_set cut down by
-- flag_role_set), so the stand-in's Restricted decision agrees with what RLS shows.
CREATE OR REPLACE FUNCTION claim_meta(ws uuid)
RETURNS TABLE (id text, entity text, attribute text, state text, trust text, role_set text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.entity, c.attribute, c.state, c.trust,
    CASE WHEN c.flag_role_set IS NULL THEN c.role_set
         ELSE ARRAY(SELECT r FROM unnest(c.role_set) AS r WHERE r = ANY(c.flag_role_set)) END
  FROM claims c
  WHERE c.workspace_id = ws
    AND (us_claim('workspace_id') IS NULL OR us_claim('workspace_id')::uuid = ws)
  ORDER BY c.id
$$;
REVOKE ALL ON FUNCTION claim_meta(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_meta(uuid) TO us_reader;
DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION claim_meta(uuid) TO %I', current_user);
END $$;

-- ---------------------------------------------------------------------------
-- count_limited: messages in sources the role can open that were limited away from it
-- ---------------------------------------------------------------------------
-- Head versions only. Count only: never topic, category, author or reason.
CREATE OR REPLACE FUNCTION count_limited(ws uuid, role text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer
  FROM segments s
  WHERE s.workspace_id = ws
    AND (us_claim('workspace_id') IS NULL OR us_claim('workspace_id')::uuid = ws)
    AND s.sensitivity <> '{}'
    AND s.role_set_original IS NOT NULL
    AND role = ANY(s.role_set_original)
    AND NOT (role = ANY(s.role_set))
    AND s.version = (SELECT max(v.version) FROM segments v WHERE v.workspace_id = s.workspace_id AND v.id = s.id)
$$;
REVOKE ALL ON FUNCTION count_limited(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION count_limited(uuid, text) TO us_reader;
DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION count_limited(uuid, text) TO %I', current_user);
END $$;

-- ---------------------------------------------------------------------------
-- sensitivity_checked and probe_runs (admin path only: no grant to us_reader)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sensitivity_checked (
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  segment_id          text NOT NULL,
  classifier_version  integer NOT NULL,
  checked_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, segment_id)
);

CREATE TABLE IF NOT EXISTS probe_runs (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id            text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,
  snapshot_id   text,
  model_tag     text NOT NULL DEFAULT '',
  judge_used    boolean NOT NULL DEFAULT false,
  cells         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ role, surface, row, texts, leaks, unconfirmed }]
  findings      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ factId, role, surface, by, quote, confirmed }]
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS probe_runs_latest ON probe_runs (workspace_id, created_at DESC);

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON sensitivity_checked, probe_runs FROM %I', r);
    END IF;
  END LOOP;
END $$;
