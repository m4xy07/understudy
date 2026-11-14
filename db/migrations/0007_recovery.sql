-- 0007_recovery: unreachable-leaver recovery (Round 3, improvement 1).
-- Contract: docs/ARCHITECTURE.md section 4, "Recovery".
--
--   * workspaces gains the switch: leaver_unreachable, when, why, and the successor run that
--     was the latest one when the switch went on (the baseline of the before and after panel).
--   * recovery_steps: one row per rung outcome per gap (a neighbour considered, a trace found,
--     an option offered, or "the rung ran and found nothing"). Read under RLS by role_set,
--     exactly like claims. Written on the admin path only; every status change is audited.
--   * segments.kind gains 'run': one CI run of the code host's run history. Extraction never
--     reads these; the trace reader does.
-- The claims.origin values 'neighbour_answer' and 'trace' and the role_holders table were added
-- once for all improvements in 0006_packs.sql.
-- Idempotent: safe to re-run.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS leaver_unreachable      boolean NOT NULL DEFAULT false;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS leaver_unreachable_at   timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS leaver_unreachable_note text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS recovery_baseline_run   text;

-- Widen the segment kind check without dropping a value another migration may have added.
DO $$
DECLARE
  def   text;
  kinds text[] := ARRAY['message','commit','file','task','note','event','answer','finding','run'];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
    WHERE conrelid = 'segments'::regclass AND conname = 'segments_kind_check';
  IF def IS NOT NULL THEN
    SELECT array_agg(DISTINCT k ORDER BY k) INTO kinds FROM (
      SELECT (regexp_matches(lower(def), '([a-z_]+)', 'g'))[1] AS k
      UNION SELECT unnest(kinds)
    ) x WHERE k NOT IN ('check', 'kind', 'any', 'array', 'text', 'in');
    ALTER TABLE segments DROP CONSTRAINT segments_kind_check;
  END IF;
  EXECUTE format('ALTER TABLE segments ADD CONSTRAINT segments_kind_check CHECK (kind = ANY (%L::text[]))', kinds);
END $$;

CREATE TABLE IF NOT EXISTS recovery_steps (
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id                 text NOT NULL,
  responsibility_id  text NOT NULL,
  check_key          text NOT NULL,
  rung               smallint NOT NULL CHECK (rung IN (1, 2, 3)),
  kind               text NOT NULL CHECK (kind IN ('neighbour', 'trace', 'option', 'none')),
  position           integer NOT NULL DEFAULT 0,
  target_person      text,
  target_role        text,
  target_ref         text,
  status             text NOT NULL CHECK (status IN (
                       'asked', 'answered', 'declined', 'skipped_no_access', 'skipped_no_seat',
                       'found', 'offered', 'none', 'not_applicable')),
  score              double precision,
  reason             text NOT NULL DEFAULT '',
  question_text      text,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  claim_id           text,
  role_set           text[] NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS recovery_steps_gap
  ON recovery_steps (workspace_id, responsibility_id, check_key, rung, position);

GRANT SELECT ON recovery_steps TO us_reader;
ALTER TABLE recovery_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_steps FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS us_reader_select ON recovery_steps';
  EXECUTE 'CREATE POLICY us_reader_select ON recovery_steps FOR SELECT TO us_reader USING ('
    || 'workspace_id = us_claim(''workspace_id'')::uuid '
    || 'AND us_claim(''role_key'') = ANY(role_set))';
  EXECUTE 'DROP POLICY IF EXISTS us_admin_all ON recovery_steps';
  EXECUTE format('CREATE POLICY us_admin_all ON recovery_steps FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON recovery_steps FROM %I', r);
    END IF;
  END LOOP;
END $$;
