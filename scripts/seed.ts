// Loads data/demo/model_cache.json (if present) into model_cache so the demo replays
// model outputs instantly and identically. Usage: pnpm db:seed
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

interface CacheRow {
  input_hash: string;
  model_tag: string;
  output: unknown;
  created_at?: string;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  const file = path.join(process.cwd(), "data", "demo", "model_cache.json");
  if (!fs.existsSync(file)) {
    console.log("no data/demo/model_cache.json yet; nothing to seed");
    return;
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as CacheRow[] | { rows: CacheRow[] };
  const rows = Array.isArray(raw) ? raw : raw.rows;
  const sql = postgres(url, {
    prepare: false,
    max: 1,
    // One query in flight per connection: safe on Supabase's transaction pooler (port 6543) too.
    max_pipeline: 1,
    ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : "require",
    onnotice: () => {},
  });
  try {
    let n = 0;
    for (const r of rows) {
      await sql`
        INSERT INTO model_cache (input_hash, model_tag, output)
        VALUES (${r.input_hash}, ${r.model_tag}, ${JSON.stringify(r.output)}::jsonb)
        ON CONFLICT (input_hash) DO NOTHING`;
      n++;
    }
    console.log(`seeded ${n} model cache row(s)`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
