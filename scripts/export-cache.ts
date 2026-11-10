// Dumps the model_cache table to data/demo/model_cache.json (sorted, stable) so the
// precomputed demo outputs can be committed and replayed by pnpm db:seed.
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

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
    const rows = await sql<{ input_hash: string; model_tag: string; output: unknown; created_at: Date }[]>`
      SELECT input_hash, model_tag, output, created_at FROM model_cache ORDER BY input_hash`;
    const out = rows.map((r) => ({
      input_hash: r.input_hash,
      model_tag: r.model_tag,
      output: r.output,
      created_at: r.created_at.toISOString(),
    }));
    const file = path.join(process.cwd(), "data", "demo", "model_cache.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
    console.log(`wrote ${out.length} row(s) to ${path.relative(process.cwd(), file)}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
