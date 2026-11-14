// Precomputes every model answer one pack's demo needs and writes them to <demo.dataDir>/model_cache.json.
// One run covers every callJson the demo makes: Attest extraction and the support check, the Lacuna
// stand-in successor for every role the pack tests, and the re-test after a leaver answer.
//  1. a fresh demo workspace runs the full pipeline against the live model (cold), then the leaver
//     answers the top gap question (the re-test runs the stand-in again);
//  2. a second fresh demo workspace does the same and must replay the pipeline 100% from the cache
//     with identical claims, scores and questions;
//  3. the cache rows used are merged (union by input_hash) into <demo.dataDir>/model_cache.json.
// The re-test of the answered responsibility cannot replay: its prompt holds the new answer claim,
// whose id comes from the answer's time. Every other responsibility replays.
// The sample leaver answer is the pack's demo.sampleAnswer.
// Usage: pnpm tsx scripts/precompute.ts [--pack <id>] [--keep]
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db/client";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { runToEnd, SCRIPT_RUN } from "@/lib/pipeline/run";
import { getExtraction } from "@/lib/attest";
import { evaluateWorkspace } from "@/lib/attest/evaluation";
import { answerQuestion } from "@/lib/lacuna";
import { getLatestTestRun, listGapQuestions } from "@/lib/db/queries";
import { modelAvailable, modelTag, startRecording, stopRecording, type CallRecord } from "@/lib/model/client";
import { defaultPackId, getPack } from "@/lib/pack";

const keep = process.argv.includes("--keep");
const PRODUCTION_TAG = "qwen/qwen3-32b@openrouter.ai";
const packArg = process.argv.indexOf("--pack");
const pack = getPack(packArg === -1 ? defaultPackId() : (process.argv[packArg + 1] ?? ""));
if (!pack.demo) throw new Error(`Setting pack "${pack.id}" has no demo to precompute.`);
const ANSWER = String(pack.demo.sampleAnswer ?? "I handed it over in person. Ask the new owner.");

interface CacheRow { input_hash: string; model_tag: string; output: unknown; created_at?: string }

async function purge(ws: string) {
  await db().begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${ws}`;
  });
}

const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const calls = (r: CallRecord) => `${r.calls} calls (${r.cached} cached, ${r.live} live, ${r.failed} failed)`;

async function runOnce(label: string, allKeys: Set<string>) {
  const ws = (await createDemoWorkspace(pack.id)).id;

  const pipeRec = startRecording();
  const t0 = Date.now();
  const run = await runToEnd(ws, SCRIPT_RUN);
  const pipelineMs = Date.now() - t0;
  stopRecording();

  const ext = await getExtraction(ws);
  const batches = ext?.batches ?? [];
  const step = (k: string) => run?.steps.find((x) => x.key === k);
  const stepMs = (k: string) => {
    const st = step(k);
    return st?.startedAt && st.finishedAt ? Date.parse(st.finishedAt) - Date.parse(st.startedAt) : 0;
  };
  console.log(`[${label}] ${ws}: run ${run?.status} in ${s(pipelineMs)}; ${calls(pipeRec)}`);
  console.log(
    `[${label}]   reconstruct ${s(stepMs("reconstruct"))} (${batches.length} batches, ${batches.filter((b) => b.ok && b.cached).length} cached, ` +
      `${batches.filter((b) => !b.ok).length} failed); verify ${s(stepMs("verify"))}; test ${s(stepMs("test"))}; ask ${s(stepMs("ask"))}`,
  );
  console.log(`[${label}]   reconstruct: ${step("reconstruct")?.note ?? ""}`);
  for (const b of batches.filter((x) => !x.ok)) {
    console.error(`[${label}]   FAILED BATCH ${b.id} ${b.thread} (${b.segmentIds.length} segments): ${b.error ?? "error"}`);
  }
  console.log(`[${label}]   verify: ${JSON.stringify(step("verify")?.counts ?? {})} ${ext?.verification?.supportNote ?? ""}`);
  if (pipeRec.errors.length) console.log(`[${label}]   model errors: ${pipeRec.errors.join(" | ").slice(0, 400)}`);
  if (run?.error) console.log(`[${label}]   run error: ${run.error}`);

  const scores: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const role of pack.testRoles) {
    const t = await getLatestTestRun(ws, role);
    scores[role] = t?.scores ?? null;
    const [m] = await db()`SELECT model_used, model_note FROM test_runs WHERE workspace_id = ${ws} AND role = ${role} ORDER BY created_at DESC LIMIT 1`;
    notes.push(`${role}: model ${m?.model_used ? "used" : "not used"}${m?.model_note ? ` (${m.model_note})` : ""}`);
  }
  console.log(`[${label}]   scores before answers: ${JSON.stringify(scores)}${notes.length ? `; ${notes.join("; ")}` : ""}`);

  const claims = await db()`
    SELECT id, value, state, trust, superseded_by, support_check, tier FROM claims WHERE workspace_id = ${ws} ORDER BY id`;
  const questions = (await listGapQuestions(ws)).map((q) => [q.rank, q.checkKey, q.gapType, q.text, q.score]); // ids carry the workspace id
  // Score the claims before the leaver's answer adds one.
  const evaluation = await evaluateWorkspace(ws);

  // The leaver answers the top open question; the stand-in re-tests both roles.
  const answerRec = startRecording();
  const t1 = Date.now();
  const [q] = (await listGapQuestions(ws)).filter((x) => !x.answeredClaimId);
  const ans = q ? await answerQuestion(ws, q.id, ANSWER, pack.leaverRole) : null;
  const answerMs = Date.now() - t1;
  stopRecording();
  console.log(
    `[${label}]   leaver answer + re-test ${s(answerMs)}: ${calls(answerRec)}; ` +
      (ans?.ok ? `${JSON.stringify(ans.before)} -> ${JSON.stringify(ans.after)}` : `no answer (${ans && !ans.ok ? ans.error : "no question"})`),
  );

  // The pipeline's keys are exported here; re-test prompts that repeat in both runs are added in
  // main(). The answered responsibility's prompt (new claim id from the answer time) never repeats.
  for (const k of pipeRec.keys) allKeys.add(k);
  const reused = [...answerRec.keys].filter((k) => pipeRec.keys.has(k)).length;
  console.log(`[${label}]   re-test prompts identical to the pipeline's: ${reused} of ${answerRec.keys.size}`);
  return { ws, pipelineMs, pipeRec, answerRec, answerMs, claims, scores, questions, evaluation };
}

function fingerprint(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows.map((r) => [r.id, r.value, r.state, r.trust, r.superseded_by, r.support_check, r.tier]));
}

async function main() {
  const tag = modelTag();
  console.log(`model ${tag}; reachable: ${await modelAvailable()}`);
  if (tag !== PRODUCTION_TAG) console.warn(`WARNING: model tag ${tag} is not the production tag ${PRODUCTION_TAG}; production will not hit these rows.`);
  const keys = new Set<string>();
  const cold = await runOnce("run 1", keys);
  const warm = await runOnce("run 2", keys);

  // Re-test prompts that both runs sent are independent of the answer's time, so they replay in
  // the demo too: export them with the pipeline's. (The answered responsibility's prompt differs.)
  const stableRetest = [...cold.answerRec.keys].filter((k) => warm.answerRec.keys.has(k) && !keys.has(k));
  for (const k of stableRetest) keys.add(k);
  console.log(`answer re-test prompts sent by both runs (exported too): ${stableRetest.length} beyond the pipeline's`);

  const sameClaims = fingerprint(cold.claims) === fingerprint(warm.claims);
  const sameScores = JSON.stringify(cold.scores) === JSON.stringify(warm.scores);
  const sameQuestions = JSON.stringify(cold.questions) === JSON.stringify(warm.questions);
  const fullyCached = warm.pipeRec.calls > 0 && warm.pipeRec.cached === warm.pipeRec.calls;
  console.log(`second pipeline fully cached: ${fullyCached} (${warm.pipeRec.cached}/${warm.pipeRec.calls})`);
  console.log(`identical claims: ${sameClaims} (${cold.claims.length} vs ${warm.claims.length}); identical scores: ${sameScores}; identical questions: ${sameQuestions}`);
  console.log(`pipeline time: cold ${s(cold.pipelineMs)}, cached ${s(warm.pipelineMs)}`);
  console.log(`answer re-test: cold ${calls(cold.answerRec)} in ${s(cold.answerMs)}; second ${calls(warm.answerRec)} in ${s(warm.answerMs)}`);

  const r = warm.evaluation.report;
  const pct = (x: { value: number | null }) => (x.value === null ? "n/a" : (x.value * 100).toFixed(1) + "%");
  console.log(
    `eval: precision strict ${pct(r.precision)} (${r.precision.num}/${r.precision.den}), on answer-key topics ${pct(r.topicPrecision)} (${r.topicPrecision.num}/${r.topicPrecision.den}), recall ${pct(r.recall)} (${r.recall.num}/${r.recall.den}), ` +
      `citations ${pct(r.citationPassRate)}, from record ${pct(r.fromRecordShare)}, false conflicts ${r.falseConflicts.count}, ` +
      `supersessions ${r.supersessions.found}/${r.supersessions.expected}, planted conflicts ${r.plantedConflicts.found}/${r.plantedConflicts.expected}, ` +
      `secrets ${r.secretsLeaked.count}, restricted ${r.restrictedViolations.count}`,
  );

  // Union by input_hash: rows already in the file are kept; every row this run used is added.
  const rows = await db()<CacheRow[]>`
    SELECT input_hash, model_tag, output, created_at FROM model_cache WHERE input_hash = ANY(${[...keys]}::text[])`;
  const file = path.join(process.cwd(), pack.demo!.dataDir, "model_cache.json");
  const existing: CacheRow[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  const byHash = new Map(existing.map((x) => [x.input_hash, x]));
  for (const r2 of rows) {
    if (byHash.has(r2.input_hash)) continue;
    byHash.set(r2.input_hash, {
      input_hash: r2.input_hash,
      model_tag: r2.model_tag,
      output: r2.output,
      created_at: (r2.created_at as unknown) instanceof Date ? (r2.created_at as unknown as Date).toISOString() : String(r2.created_at ?? ""),
    });
  }
  const out = [...byHash.values()].sort((a, b) => (a.input_hash < b.input_hash ? -1 : 1));
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  const missing = [...keys].filter((k) => !byHash.has(k)).length;
  console.log(
    `wrote ${out.length} row(s) to ${path.relative(process.cwd(), file)} (${rows.length} of ${keys.size} pipeline and repeatable re-test keys are cached;` +
      `${missing} not cached: failed calls)`,
  );

  if (!keep) {
    await purge(cold.ws);
    await purge(warm.ws);
  }
  await db().end();
  if (!sameClaims || !sameScores || !sameQuestions || !fullyCached) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
