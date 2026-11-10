-- 0003_attest: extraction drafts and verifier drops (Attest).
-- Contract: docs/ARCHITECTURE.md section 4 "Claims (Attest)".
--
-- attest_runs     one row per workspace: the latest extraction drafts (model + structured),
--                 the batch report and the latest verification summary. Admin path only.
-- attest_dropped  drafts the verifier dropped (no accepted citation), counted per source.
--                 Role-scoped like claims: role_set = the role set of the batch the model saw,
--                 so a dropped draft from #finance is only listed to roles that may see #finance.
--                 It is a projection rebuilt by every verify (not append-only); the audit trail
--                 of every state change stays in claim_events.

CREATE TABLE IF NOT EXISTS attest_runs (
  workspace_id   uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  drafts         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- DraftClaim[] (core/schema.ts)
  batches        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- BatchReport[] (core/extract.ts)
  off_list       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- OffListClaim[]
  model_used     boolean NOT NULL DEFAULT false,
  model_note     text,
  extract_ms     integer,
  extracted_at   timestamptz NOT NULL DEFAULT now(),
  verification   jsonb,                                -- summary of the latest verify()
  verified_at    timestamptz
);

CREATE TABLE IF NOT EXISTS attest_dropped (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id            text NOT NULL,
  source_id     text NOT NULL,
  source_kind   text,
  reason        text NOT NULL,
  entity        text NOT NULL,
  attribute     text NOT NULL,
  value         text NOT NULL,
  statement     text NOT NULL,
  citations     jsonb NOT NULL DEFAULT '[]'::jsonb,
  role_set      text[] NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS attest_dropped_source ON attest_dropped (workspace_id, source_id);

GRANT SELECT ON attest_dropped TO us_reader;
ALTER TABLE attest_dropped ENABLE ROW LEVEL SECURITY;
ALTER TABLE attest_dropped FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS us_reader_select ON attest_dropped';
  EXECUTE 'CREATE POLICY us_reader_select ON attest_dropped FOR SELECT TO us_reader USING ('
    || 'workspace_id = us_claim(''workspace_id'')::uuid '
    || 'AND us_claim(''role_key'') = ANY(role_set))';
  EXECUTE 'DROP POLICY IF EXISTS us_admin_all ON attest_dropped';
  EXECUTE format('CREATE POLICY us_admin_all ON attest_dropped FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON attest_runs, attest_dropped FROM %I', r);
    END IF;
  END LOOP;
END $$;
