// Precomputes the demo's model answers and commits them as data/demo/model_cache.json.
//  1. a fresh demo workspace runs the full pipeline against the live model (cold);
//  2. a second fresh demo workspace runs it again and must be fully cached with identical claims;
//  3. the cache rows Attest used are merged (by input_hash) into data/demo/model_cache.json.
// Usage: pnpm tsx scripts/precompute.ts [--keep]
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db/client";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { executeRun, startRun } from "@/lib/pipeline/run";
import { getExtraction } from "@/lib/attest";
import { evaluateWorkspace } from "@/lib/attest/evaluation";
import { startRecordingKeys, stopRecordingKeys } from "@/lib/attest/model";
import { modelAvailable, modelTag } from "@/lib/model/client";

const keep = process.argv.includes("--keep");

interface CacheRow { input_hash: string; model_tag: string; output: unknown; created_at?: string }

async function purge(ws: string) {
  await db().begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${ws}`;
  });
}

async function runOnce(label: string) {
  const ws = (await createDemoWorkspace()).id;
  const t0 = Date.now();
  const { runId } = await startRun(ws);
  const run = await executeRun(ws, runId);
  const ms = Date.now() - t0;
  const ext = await getExtraction(ws);
  const batches = ext?.batches ?? [];
  const cached = batches.filter((b) => b.ok && b.cached).length;
  const failed = batches.filter((b) => !b.ok).length;
  const step = (k: string) => run?.steps.find((s) => s.key === k);
  console.log(
    `[${label}] ${ws}: run ${run?.status} in ${(ms / 1000).toFixed(1)} s; extraction ${((ext?.extractMs ?? 0) / 1000).toFixed(1)} s, ` +
      `${batches.length} batches (${cached} cached, ${failed} failed); verify ${((ext?.verification?.ms ?? 0) / 1000).toFixed(1)} s`,
  );
  console.log(`[${label}] reconstruct: ${step("reconstruct")?.note ?? ""}`);
  console.log(`[${label}] verify: ${JSON.stringify(step("verify")?.counts ?? {})} ${ext?.verification?.supportNote ?? ""}`);
  if (run?.error) console.log(`[${label}] run error: ${run.error}`);
  const claims = await db()`
    SELECT id, value, state, trust, superseded_by, support_check FROM claims WHERE workspace_id = ${ws} ORDER BY id`;
  return { ws, ms, extractMs: ext?.extractMs ?? 0, batches: batches.length, cached, failed, claims };
}

function fingerprint(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows.map((r) => [r.id, r.value, r.state, r.trust, r.superseded_by, r.support_check]));
}

async function main() {
  console.log(`model ${modelTag()}; reachable: ${await modelAvailable()}`);
  startRecordingKeys();
  const cold = await runOnce("run 1");
  const warm = await runOnce("run 2");
  const keys = stopRecordingKeys();

  const same = fingerprint(cold.claims) === fingerprint(warm.claims);
  console.log(`second run fully cached: ${warm.cached === warm.batches && warm.failed === 0} (${warm.cached}/${warm.batches})`);
  console.log(`identical claims: ${same} (${cold.claims.length} vs ${warm.claims.length})`);
  console.log(`extraction time: cold ${(cold.extractMs / 1000).toFixed(1)} s, cached ${(warm.extractMs / 1000).toFixed(1)} s`);

  const e = await evaluateWorkspace(cold.ws);
  const r = e.report;
  const pct = (x: { value: number | null }) => (x.value === null ? "n/a" : (x.value * 100).toFixed(1) + "%");
  console.log(
    `eval: precision strict ${pct(r.precision)} (${r.precision.num}/${r.precision.den}), on answer-key topics ${pct(r.topicPrecision)} (${r.topicPrecision.num}/${r.topicPrecision.den}), recall ${pct(r.recall)} (${r.recall.num}/${r.recall.den}), ` +
      `citations ${pct(r.citationPassRate)}, from record ${pct(r.fromRecordShare)}, false conflicts ${r.falseConflicts.count}, ` +
      `supersessions ${r.supersessions.found}/${r.supersessions.expected}, secrets ${r.secretsLeaked.count}, restricted ${r.restrictedViolations.count}`,
  );

  // Merge the rows Attest used into the committed cache file (other modules' rows are kept).
  const rows = await db()<CacheRow[]>`
    SELECT input_hash, model_tag, output, created_at FROM model_cache WHERE input_hash = ANY(${[...keys]}::text[])`;
  const file = path.join(process.cwd(), "data", "demo", "model_cache.json");
  const existing: CacheRow[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  const byHash = new Map(existing.map((x) => [x.input_hash, x]));
  for (const r2 of rows) {
    byHash.set(r2.input_hash, {
      input_hash: r2.input_hash,
      model_tag: r2.model_tag,
      output: r2.output,
      created_at: (r2.created_at as unknown) instanceof Date ? (r2.created_at as unknown as Date).toISOString() : String(r2.created_at ?? ""),
    });
  }
  const out = [...byHash.values()].sort((a, b) => (a.input_hash < b.input_hash ? -1 : 1));
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  console.log(`wrote ${out.length} row(s) (${rows.length} used by Attest in this run) to ${path.relative(process.cwd(), file)}`);

  if (!keep) {
    await purge(cold.ws);
    await purge(warm.ws);
  }
  await db().end();
  if (!same || warm.failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
