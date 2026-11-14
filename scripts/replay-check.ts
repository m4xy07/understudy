// Replays a fresh demo workspace against the committed model cache with the live model off,
// and prints a fingerprint of what came out (claims, scores, questions, cache hits).
// Two runs of this script on two commits must print the same fingerprint when no prompt changed.
// Usage: pnpm db:seed && MODEL_DISABLED=1 pnpm tsx scripts/replay-check.ts [--pack id] [--out file.json] [--keep]
import "./load-env";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { db } from "@/lib/db/client";
import { defaultPackId } from "@/lib/pack";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { executeRun, startRun } from "@/lib/pipeline/run";
import { getExtraction } from "@/lib/attest";
import { listGapQuestions } from "@/lib/db/queries";
import { startRecording, stopRecording } from "@/lib/model/client";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
};
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

async function main() {
  process.env.MODEL_DISABLED = "1";
  const ws = (await createDemoWorkspace(arg("--pack") ?? defaultPackId())).id;
  const rec = startRecording();
  const { runId } = await startRun(ws);
  const run = await executeRun(ws, runId);
  stopRecording();

  const batches = (await getExtraction(ws))?.batches ?? [];
  const claims = await db()`
    SELECT id, entity, attribute, value, statement, state, trust, superseded_by, support_check, tier, importance, origin, role_set
    FROM claims WHERE workspace_id = ${ws} ORDER BY id`;
  const tests = await db()`
    SELECT DISTINCT ON (role) role, scores, model_used FROM test_runs WHERE workspace_id = ${ws} ORDER BY role, created_at DESC`;
  const questions = (await listGapQuestions(ws)).map((q) => [q.rank, q.checkKey, q.gapType, q.text, q.score]);
  const segments = await db()`SELECT id FROM segments WHERE workspace_id = ${ws} ORDER BY id`;

  const out = {
    run: run?.status,
    modelCalls: { calls: rec.calls, cached: rec.cached, live: rec.live, failed: rec.failed },
    cacheKeysHash: sha([...rec.keys].sort()),
    batches: { total: batches.length, cached: batches.filter((b) => b.ok && b.cached).length, failed: batches.filter((b) => !b.ok).length },
    segments: { count: segments.length, idsHash: sha(segments.map((s) => s.id)) },
    claims: {
      count: claims.length,
      idsHash: sha(claims.map((c) => c.id)),
      fullHash: sha(claims),
      byState: Object.fromEntries([...new Set(claims.map((c) => String(c.state)))].sort().map((s) => [s, claims.filter((c) => c.state === s).length])),
      byTrust: Object.fromEntries([...new Set(claims.map((c) => String(c.trust)))].sort().map((s) => [s, claims.filter((c) => c.trust === s).length])),
      byTier: Object.fromEntries([...new Set(claims.map((c) => String(c.tier)))].sort().map((s) => [s, claims.filter((c) => c.tier === s).length])),
    },
    scores: Object.fromEntries(tests.map((t) => [String(t.role), { scores: t.scores, modelUsed: t.model_used }])),
    questions: { count: questions.length, hash: sha(questions) },
  };
  console.log(JSON.stringify(out, null, 2));
  const file = arg("--out");
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");

  if (!process.argv.includes("--keep")) {
    await db().begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await db().end();
  const fullyCached = rec.calls > 0 && rec.cached === rec.calls && out.batches.cached === out.batches.total;
  if (!fullyCached) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
