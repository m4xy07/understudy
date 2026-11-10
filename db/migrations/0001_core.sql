-- 0001_core: the full Understudy schema (all modules), mirroring src/lib/types.ts.
-- Contract: docs/ARCHITECTURE.md sections 4 and 5.
--
-- Permission design (section 5, "RLS is the compile boundary"):
--   * Tables are owned by the migration user (the app user: `postgres` locally and on Supabase).
--   * Role `us_reader` (NOLOGIN) gets SELECT on the role-scoped tables only. The app user is
--     granted membership so it can `SET LOCAL ROLE us_reader` inside withRole().
--   * RLS is ENABLED and FORCED on segments, claims, contacts, snapshot_claims, so even the
--     table owner is subject to policies (Supabase's `postgres` is not a superuser).
--   * Two permissive policies per table:
--       us_reader_select  FOR SELECT TO us_reader: workspace + role_key from request.jwt.claims.
--       us_admin_all      FOR ALL    TO <migration user>: admin import/extraction/review writes.
--     After SET ROLE us_reader, current_user is us_reader, which is not a member of the
--     migration user, so only the reader policy applies. The membership grant uses
--     INHERIT FALSE (PG16+) so the reader policy never widens or narrows the admin path.
--   * count_withheld() is SECURITY DEFINER and returns an integer only.
--   * claim_events, acknowledgements, audit_log are append-only (trigger + revoked grants);
--     segments are immutable (UPDATE blocked by trigger).

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'us_reader') THEN
    CREATE ROLE us_reader NOLOGIN;
  END IF;
END $$;

DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE 'GRANT us_reader TO CURRENT_USER WITH INHERIT FALSE, SET TRUE';
  ELSE
    EXECUTE 'GRANT us_reader TO CURRENT_USER';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO us_reader;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Reads one key of the per-transaction claims set by withRole(). Empty string when unset.
CREATE OR REPLACE FUNCTION us_claim(key text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> key
$$;

-- Blocks UPDATE/DELETE/TRUNCATE on append-only tables. A purge of expired workspaces may
-- delete rows only when the transaction sets us.allow_purge = 'on' (see purge_workspaces).
CREATE OR REPLACE FUNCTION us_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('us.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- Segments are immutable: a changed re-import creates a new version row.
CREATE OR REPLACE FUNCTION us_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable: insert a new version instead', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------
-- Workspaces and sources (Tether)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('demo', 'empty')),
  pack_id     text NOT NULL DEFAULT 'club',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id              text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('whatsapp','slack','github','tasks_csv','markdown','ics','interview')),
  name            text NOT NULL,
  role_set        text[] NOT NULL,
  segment_count   integer NOT NULL DEFAULT 0,
  rejected        jsonb NOT NULL DEFAULT '[]'::jsonb,
  masked_secrets  integer NOT NULL DEFAULT 0,
  masked_contacts integer NOT NULL DEFAULT 0,
  origin          text NOT NULL DEFAULT 'demo',   -- demo | upload | github
  imported_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS people (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id            text NOT NULL,                  -- "p-<n>"
  display_name  text NOT NULL,
  email_hmac    text,
  aliases       text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS people_email_hmac ON people (workspace_id, email_hmac) WHERE email_hmac IS NOT NULL;

CREATE TABLE IF NOT EXISTS segments (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id            text NOT NULL,                  -- seg_ + 16 hex
  version       integer NOT NULL DEFAULT 1,
  source_id     text NOT NULL,
  source_kind   text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('message','commit','file','task','note','event','answer')),
  ts            timestamptz NOT NULL,
  author_id     text,
  thread        text NOT NULL,
  position      integer NOT NULL DEFAULT 0,
  text          text NOT NULL,                  -- already masked
  text_hash     text NOT NULL,
  role_set      text[] NOT NULL,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id, version),
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS segments_source ON segments (workspace_id, source_id);
CREATE INDEX IF NOT EXISTS segments_thread ON segments (workspace_id, thread, ts);

CREATE TABLE IF NOT EXISTS contacts (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token         text NOT NULL,                  -- placeholder in segment text, e.g. [CONTACT:p-3]
  kind          text NOT NULL CHECK (kind IN ('email','phone')),
  person_id     text,
  value_enc     text NOT NULL,                  -- AES-256-GCM, never plain
  role_set      text[] NOT NULL,                -- pack.contactsRoles intersected with the source roles
  source_id     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, token, kind)
);

-- ---------------------------------------------------------------------------
-- Claims (Attest)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claims (
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id             text NOT NULL,
  entity         text NOT NULL,
  entity_label   text NOT NULL,
  attribute      text NOT NULL CHECK (attribute IN ('owner','status','deadline','location','procedure','access','decision','reason','dependency','contact','risk')),
  value          text NOT NULL,
  statement      text NOT NULL,
  citations      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- Citation[]
  trust          text NOT NULL CHECK (trust IN ('from_record','corroborated','leaver_said','second_hand','inferred','ranked_options')),
  state          text NOT NULL DEFAULT 'active' CHECK (state IN ('active','superseded','conflicting','dropped')),
  state_note     text,
  superseded_by  text,
  role_set       text[] NOT NULL,
  valid_from     timestamptz NOT NULL,
  author_id      text,
  source_kinds   text[] NOT NULL DEFAULT '{}',
  importance     text NOT NULL DEFAULT 'normal' CHECK (importance IN ('normal','important','blocking')),
  tier           text NOT NULL DEFAULT 'B' CHECK (tier IN ('A','B','C')),
  review         text NOT NULL DEFAULT 'pending' CHECK (review IN ('pending','approved','edited','rejected')),
  review_note    text,
  origin         text NOT NULL CHECK (origin IN ('extracted','structured','leaver_answer')),
  support_check  text CHECK (support_check IN ('yes','partly','no')),
  source_ids     text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS claims_entity ON claims (workspace_id, entity, attribute);

CREATE TABLE IF NOT EXISTS claim_events (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  claim_id      text NOT NULL,
  event         text NOT NULL,                  -- created | verified | superseded | conflicting | dropped | reviewed | edited ...
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor         text NOT NULL DEFAULT 'system',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_events_claim ON claim_events (workspace_id, claim_id);

-- ---------------------------------------------------------------------------
-- Test and Ask (Lacuna)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS responsibilities (
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id             text NOT NULL,
  key            text NOT NULL,                 -- "R01"
  title          text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('deploy_operate','external_relationship','recurring_obligation','open_decision','unfinished_work')),
  entities       text[] NOT NULL DEFAULT '{}',
  origin         text NOT NULL CHECK (origin IN ('task_board','footprint','role_template')),
  origin_detail  text NOT NULL DEFAULT '',
  due_date       date,
  confirmed      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS test_runs (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id            text NOT NULL,
  role          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  scores        jsonb NOT NULL,                 -- Scores
  results       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- CheckResult[]
  provisional   boolean NOT NULL DEFAULT true,
  model_used    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS test_runs_latest ON test_runs (workspace_id, role, created_at DESC);

CREATE TABLE IF NOT EXISTS gap_questions (
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id                 text NOT NULL,
  rank               integer NOT NULL,
  responsibility_id  text NOT NULL,
  check_key          text NOT NULL,
  gap_type           text NOT NULL CHECK (gap_type IN ('missing','partial','conflicting')),
  text               text NOT NULL,
  score              double precision NOT NULL,
  answered_claim_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS plan_items (
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  responsibility_id  text NOT NULL,
  check_key          text NOT NULL,
  owner              text NOT NULL DEFAULT '',
  due_date           date,
  risk_note          text NOT NULL DEFAULT '',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, responsibility_id, check_key)
);

-- ---------------------------------------------------------------------------
-- Review and Handover (Relay)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshots (
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id             text NOT NULL,
  version        integer NOT NULL,
  hash           text NOT NULL,
  approved_by    text NOT NULL CHECK (approved_by = 'president'),
  approved_at    timestamptz NOT NULL DEFAULT now(),
  claim_ids      text[] NOT NULL DEFAULT '{}',
  open_blocking  integer NOT NULL DEFAULT 0,
  plan           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- PlanItem[]
  payload        jsonb NOT NULL,                       -- the canonical JSON that was hashed
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, version)
);

CREATE TABLE IF NOT EXISTS snapshot_claims (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id   text NOT NULL,
  claim_id      text NOT NULL,
  entity        text NOT NULL,
  entity_label  text NOT NULL DEFAULT '',
  attribute     text NOT NULL,
  statement     text NOT NULL,
  trust         text NOT NULL,
  valid_from    timestamptz,
  citations     jsonb NOT NULL DEFAULT '[]'::jsonb,
  role_set      text[] NOT NULL,
  PRIMARY KEY (workspace_id, snapshot_id, claim_id),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES snapshots(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS acknowledgements (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id    text NOT NULL,
  snapshot_hash  text NOT NULL,
  role           text NOT NULL,
  verdicts       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ReadbackVerdict[]
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Pipeline runs, model cache, audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  steps         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- RunStep[] (src/lib/pipeline/run.ts)
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS runs_latest ON runs (workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS model_cache (
  input_hash  text PRIMARY KEY,                 -- sha256(model tag + system + user + schema name)
  model_tag   text NOT NULL,
  output      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  actor         text NOT NULL,                  -- role key or 'system'
  action        text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_ws ON audit_log (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Append-only and immutability
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON claim_events, acknowledgements, audit_log FROM PUBLIC;
REVOKE UPDATE ON segments FROM PUBLIC;

DROP TRIGGER IF EXISTS claim_events_append_only ON claim_events;
CREATE TRIGGER claim_events_append_only BEFORE UPDATE OR DELETE ON claim_events
  FOR EACH ROW EXECUTE FUNCTION us_append_only();
DROP TRIGGER IF EXISTS claim_events_no_truncate ON claim_events;
CREATE TRIGGER claim_events_no_truncate BEFORE TRUNCATE ON claim_events
  FOR EACH STATEMENT EXECUTE FUNCTION us_append_only();

DROP TRIGGER IF EXISTS acknowledgements_append_only ON acknowledgements;
CREATE TRIGGER acknowledgements_append_only BEFORE UPDATE OR DELETE ON acknowledgements
  FOR EACH ROW EXECUTE FUNCTION us_append_only();
DROP TRIGGER IF EXISTS acknowledgements_no_truncate ON acknowledgements;
CREATE TRIGGER acknowledgements_no_truncate BEFORE TRUNCATE ON acknowledgements
  FOR EACH STATEMENT EXECUTE FUNCTION us_append_only();

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION us_append_only();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION us_append_only();

DROP TRIGGER IF EXISTS segments_immutable ON segments;
CREATE TRIGGER segments_immutable BEFORE UPDATE ON segments
  FOR EACH ROW EXECUTE FUNCTION us_immutable();

-- ---------------------------------------------------------------------------
-- Row-level security on the role-scoped tables
-- ---------------------------------------------------------------------------
GRANT SELECT ON segments, claims, contacts, snapshot_claims TO us_reader;

ALTER TABLE segments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments        FORCE  ROW LEVEL SECURITY;
ALTER TABLE claims          ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims          FORCE  ROW LEVEL SECURITY;
ALTER TABLE contacts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts        FORCE  ROW LEVEL SECURITY;
ALTER TABLE snapshot_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshot_claims FORCE  ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['segments', 'claims', 'contacts', 'snapshot_claims'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS us_reader_select ON %I', t);
    EXECUTE format(
      'CREATE POLICY us_reader_select ON %I FOR SELECT TO us_reader USING ('
      || 'workspace_id = us_claim(''workspace_id'')::uuid '
      || 'AND us_claim(''role_key'') = ANY(role_set))', t);
    EXECUTE format('DROP POLICY IF EXISTS us_admin_all ON %I', t);
    EXECUTE format(
      'CREATE POLICY us_admin_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)',
      t, current_user);
  END LOOP;
END $$;

-- On Supabase the anon/authenticated API roles get default grants on public tables.
-- Understudy never uses the Data API, so remove those grants entirely.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- count_withheld: how many approved snapshot claims a role may NOT see.
-- Returns a count only (never topic, compartment, owning role or value).
-- section = 'all', one attribute (e.g. 'access'), or a comma list of attributes.
-- Uses the latest snapshot of the workspace; 0 when there is none.
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
    AND NOT (role = ANY(sc.role_set))
    AND (
      section IS NULL OR section = 'all'
      OR sc.attribute = ANY(string_to_array(replace(section, ' ', ''), ','))
    )
$$;
REVOKE ALL ON FUNCTION count_withheld(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION count_withheld(uuid, text, text) TO us_reader;

-- Deletes workspaces older than `days` (cascades through the append-only tables).
CREATE OR REPLACE FUNCTION purge_workspaces(days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('us.allow_purge', 'on', true);
  DELETE FROM workspaces WHERE created_at < now() - make_interval(days => days);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('us.allow_purge', 'off', true);
  RETURN n;
END $$;
