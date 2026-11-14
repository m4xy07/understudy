// Applies db/migrations/*.sql in name order, once each, tracked in schema_migrations.
// Idempotent: re-running applies only new files. Usage: pnpm db:migrate
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

/**
 * Run after every migrate: the Supabase Data API roles (anon, authenticated) and PUBLIC hold
 * nothing in public. Supabase grants those roles every new table, sequence and function by
 * default, so a table added by a later migration is covered here even if the migration forgets.
 * Functions lose EXECUTE for PUBLIC as well (a migration grants us_reader what the role-scoped
 * path calls, by name); extension functions are left alone. A no-op on plain Postgres, where
 * the two roles do not exist. Exported for tests/db/grants.test.ts.
 */
export const BLANKET_REVOKE_SQL = `
DO $$
DECLARE
  r text;
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f.sig, current_user);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f.sig, r);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END $$;`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  const sql = postgres(url, {
    prepare: false,
    max: 1,
    // One query in flight per connection: safe on Supabase's transaction pooler (port 6543) too.
    max_pipeline: 1,
    ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : "require",
    onnotice: () => {},
  });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
    const dir = path.join(process.cwd(), "db", "migrations");
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    let applied = 0;
    for (const file of files) {
      if (done.has(file)) continue;
      const body = fs.readFileSync(path.join(dir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body).simple();
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      console.log(`applied ${file}`);
      applied++;
    }
    await sql.unsafe(BLANKET_REVOKE_SQL).simple();
    console.log(applied ? `${applied} migration(s) applied` : "database is up to date");
  } finally {
    await sql.end();
  }
}

// Only when run as a script (pnpm db:migrate), not when a test imports BLANKET_REVOKE_SQL.
if (/(^|[\\/])migrate\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
