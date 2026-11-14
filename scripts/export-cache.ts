// Dumps the model_cache table to one pack's <demo.dataDir>/model_cache.json (sorted, stable) so
// the precomputed demo outputs can be committed and replayed by pnpm db:seed.
// Usage: pnpm db:export-cache [--pack <id>]   (scripts/precompute.ts is the normal way: it
// writes only the rows that pack's demo used)
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { defaultPackId, getPack } from "@/lib/pack";

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
    const packArg = process.argv.indexOf("--pack");
    const pack = getPack(packArg === -1 ? defaultPackId() : (process.argv[packArg + 1] ?? ""));
    if (!pack.demo) throw new Error(`Setting pack "${pack.id}" has no demo.`);
    const file = path.join(process.cwd(), pack.demo.dataDir, "model_cache.json");
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
