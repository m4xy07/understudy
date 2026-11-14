// Loads every demo pack's <demo.dataDir>/model_cache.json (if present) into model_cache so the
// demos replay model outputs instantly and identically. Usage: pnpm db:seed
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { cacheOutputText } from "@/lib/model/client";
import { listDemoPacks } from "@/lib/pack";

interface CacheRow {
  input_hash: string;
  model_tag: string;
  output: unknown;
  created_at?: string;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  // One cache file per demo pack; rows are keyed by input hash, so the files never collide.
  const rows: CacheRow[] = [];
  for (const p of listDemoPacks()) {
    const file = path.join(process.cwd(), p.demo.dataDir, "model_cache.json");
    if (!fs.existsSync(file)) {
      console.log(`no ${path.relative(process.cwd(), file)} yet; nothing to seed for pack ${p.id}`);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as CacheRow[] | { rows: CacheRow[] };
    const list = Array.isArray(raw) ? raw : raw.rows;
    console.log(`pack ${p.id}: ${list.length} row(s) in ${path.relative(process.cwd(), file)}`);
    rows.push(...list);
  }
  if (!rows.length) return;
  const sql = postgres(url, {
    prepare: false,
    max: 1,
    // One query in flight per connection: safe on Supabase's transaction pooler (port 6543) too.
    max_pipeline: 1,
    ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : "require",
    onnotice: () => {},
  });
  try {
    let inserted = 0;
    let replaced = 0;
    for (const r of rows) {
      // Stored exactly as writeCache stores an answer: the exported output is already that JSON
      // text, so it is not stringified again (a second encoding never matched a schema on read).
      // A row with the same key but other contents (an older double-encoded seed, a live answer)
      // is replaced: the committed rows are the answers the demo and the evaluation expect.
      const res = await sql`
        INSERT INTO model_cache (input_hash, model_tag, output)
        VALUES (${r.input_hash}, ${r.model_tag}, ${cacheOutputText(r.output)}::jsonb)
        ON CONFLICT (input_hash) DO UPDATE SET output = EXCLUDED.output, model_tag = EXCLUDED.model_tag
          WHERE model_cache.output IS DISTINCT FROM EXCLUDED.output
        RETURNING (xmax = 0) AS inserted`;
      if (res[0]?.inserted) inserted++;
      else if (res.length) replaced++;
    }
    console.log(`seeded ${rows.length} model cache row(s): ${inserted} new, ${replaced} replaced, ${rows.length - inserted - replaced} already current`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
