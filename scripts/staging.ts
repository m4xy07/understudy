// Prepares the staging (rehearsal) database: applies the migrations, seeds the demo model cache
// and prints row counts. Reads STAGING_POOLER_URL from .env.local; staging is a separate Supabase
// project from production. Idempotent. Usage: pnpm staging:setup
import "./load-env";
import { spawnSync } from "node:child_process";
import postgres from "postgres";

interface Parts {
  user: string;
  password: string;
  hostAndPath: string;
}

/** The password may contain '@' or other reserved characters: the host starts after the LAST '@'. */
function parse(raw: string): Parts {
  const m = /^postgres(?:ql)?:\/\/(.*)$/.exec(raw.trim());
  if (!m) throw new Error("STAGING_POOLER_URL must start with postgres:// or postgresql://");
  const at = m[1].lastIndexOf("@");
  const colon = m[1].indexOf(":");
  if (at < 0 || colon < 0 || colon > at) throw new Error("STAGING_POOLER_URL must look like postgres://user:password@host:port/db");
  let password = m[1].slice(colon + 1, at);
  try {
    password = decodeURIComponent(password); // already percent-encoded: do not encode twice
  } catch {
    // a literal '%' in the password: keep it as written
  }
  return { user: m[1].slice(0, colon), password, hostAndPath: m[1].slice(at + 1) };
}

/** user of a Supabase pooler URL is postgres.<project ref>; used to refuse the production project. */
function userOf(raw: string | undefined): string | null {
  try {
    return raw ? parse(raw).user : null;
  } catch {
    return null;
  }
}

function run(script: string, url: string): void {
  const res = spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}`], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  if (res.status !== 0) throw new Error(`${script} failed`);
}

async function main() {
  const raw = process.env.STAGING_POOLER_URL;
  if (!raw) throw new Error("STAGING_POOLER_URL is not set in .env.local");
  const { user, password, hostAndPath } = parse(raw);
  for (const name of ["SUPABASE_POOLER_URL", "SUPABASE_DIRECT_URL"]) {
    if (userOf(process.env[name]) === user && user.includes(".")) {
      throw new Error(`STAGING_POOLER_URL points at the same project as ${name} (production); refusing to run`);
    }
  }
  const url = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${hostAndPath}`;
  console.log(`staging database: ${hostAndPath.replace(/\?.*$/, "")} as ${user}`);

  // migrate.ts and seed.ts connect with ssl "require" (any non-local host) and max_pipeline 1.
  run("migrate.ts", url);
  run("seed.ts", url);

  const sql = postgres(url, { prepare: false, max: 1, max_pipeline: 1, ssl: "require", onnotice: () => {} });
  try {
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    console.log("row counts:");
    for (const { tablename } of tables) {
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(tablename)}`;
      console.log(`  ${tablename.padEnd(24)} ${n}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
