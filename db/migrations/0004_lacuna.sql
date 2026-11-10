-- Lacuna (Test and Ask). docs/ARCHITECTURE.md section 4.
--
-- claim_meta(ws): metadata of every claim in a workspace, for the Restricted decision of the
-- successor test. It returns ids, entity keys, attributes, states, trust and role sets only:
-- never statement or value text. SECURITY DEFINER so a role-scoped caller (us_reader inside
-- withRole) can learn that evidence exists for other roles without reading the rows.
-- When called inside withRole, the workspace must be the one in the request claims.

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
  ORDER BY c.id
$$;
REVOKE ALL ON FUNCTION claim_meta(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_meta(uuid) TO us_reader;
DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION claim_meta(uuid) TO %I', current_user);
END $$;

-- Why a question was asked (shown on the Ask page) and the re-test sentence after an answer.
ALTER TABLE gap_questions ADD COLUMN IF NOT EXISTS weight      integer;
ALTER TABLE gap_questions ADD COLUMN IF NOT EXISTS urgency     double precision;
ALTER TABLE gap_questions ADD COLUMN IF NOT EXISTS claim_ids   text[] NOT NULL DEFAULT '{}';
ALTER TABLE gap_questions ADD COLUMN IF NOT EXISTS score_delta text;
ALTER TABLE gap_questions ADD COLUMN IF NOT EXISTS answered_at timestamptz;

-- What triggered a test run ("pipeline", "re-run", "answer gq_…", "plan item") and model notes.
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS trigger    text NOT NULL DEFAULT 'run';
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS model_note text;

-- Who confirmed the inventory and when.
ALTER TABLE responsibilities ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
