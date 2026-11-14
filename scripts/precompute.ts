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
// Round 3 paths, each on its own fresh demo workspace so they start where a judge starts (the
// pipeline replays from the rows step 1 just made), twice, exporting the prompts both passes sent:
//  * recovery (packs whose demo has recovery samples, <demo.dataDir>/recovery.json): the approver
//    marks the leaver as unreachable, the ladder is built (traces), and each sample neighbour
//    answer is applied (precomputeRecovery);
//  * living handover (packs whose answer key has an example finding): tier A approved, every
//    blocking gap planned, snapshot v1, the successor records the example finding, the approver
//    approves it (the re-test of the affected responsibility) and v2 is released.
// Content-level confidentiality adds two things to one run: the classifier's model calls during
// ingest are recorded too, and when the demo's answer key plants a deliberate false positive
// (decoys with group "false_positive"), the approver widens it and the pipeline re-runs, so the
// scripted widening of the walkthrough replays from the cache as well.
// Usage: pnpm tsx scripts/precompute.ts [--pack <id>] [--keep]
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db/client";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { executeRun, runToEnd, SCRIPT_RUN } from "@/lib/pipeline/run";
import { getExtraction } from "@/lib/attest";
import { evaluateWorkspace } from "@/lib/attest/evaluation";
import { answerQuestion, listBlockingGaps, precomputeRecovery, recoverySamples, savePlanItem } from "@/lib/lacuna";
import { approveSnapshot, bulkApprove } from "@/lib/relay";
import { decideFinding, exampleFinding, firstWeeks, recordFinding } from "@/lib/relay/living";
import { getLatestTestRun, listGapQuestions } from "@/lib/db/queries";
import { modelAvailable, modelTag, startRecording, stopRecording, type CallRecord } from "@/lib/model/client";
import { defaultPackId, getPack } from "@/lib/pack";
import { setSegmentVisibility } from "@/lib/tether/visibility";

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

/** The text of the demo's deliberate false positive (the message the walkthrough widens), if it plants one. */
function plantedFalsePositive(): string | null {
  try {
    const gt = JSON.parse(fs.readFileSync(path.join(process.cwd(), pack.demo!.dataDir, "ground_truth.json"), "utf8")) as {
      decoys?: { group?: string; containsText?: string }[];
    };
    return gt.decoys?.find((d) => d.group === "false_positive")?.containsText ?? null;
  } catch {
    return null;
  }
}

/** The approver widens the planted false positive and the pipeline re-runs. Returns the keys it used. */
async function widenFalsePositive(label: string, ws: string): Promise<Set<string>> {
  const text = plantedFalsePositive();
  if (!text) return new Set();
  const [seg] = await db()`
    SELECT id FROM segments WHERE workspace_id = ${ws} AND position(${text} in text) > 0 AND role_set_original IS NOT NULL
    ORDER BY version DESC LIMIT 1`;
  if (!seg) {
    console.log(`[${label}]   widening: the planted false positive is not limited in this run; skipped`);
    return new Set();
  }
  const res = await setSegmentVisibility(ws, String(seg.id), { action: "widen", roles: "source", reason: "Routine and useful: it backs a procedure everyone needs." }, pack.approverRole);
  if (!res.ok || !res.runId) {
    console.log(`[${label}]   widening failed: ${res.ok ? "no run started" : res.error}`);
    return new Set();
  }
  const rec = startRecording();
  const t0 = Date.now();
  const run = await executeRun(ws, res.runId, SCRIPT_RUN);
  stopRecording();
  console.log(`[${label}]   widening + re-run ${s(Date.now() - t0)}: run ${run?.status}; ${calls(rec)}`);
  return rec.keys;
}

async function runOnce(label: string, allKeys: Set<string>) {
  // The content classifier asks the model about borderline segments during ingest: record that too.
  const ingestRec = startRecording();
  const ws = (await createDemoWorkspace(pack.id)).id;
  stopRecording();
  for (const k of ingestRec.keys) allKeys.add(k);
  console.log(`[${label}] ingest classifier: ${calls(ingestRec)}`);
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
  const widenKeys = await widenFalsePositive(label, ws);
  return { ws, pipelineMs, pipeRec, answerRec, answerMs, claims, scores, questions, evaluation, widenKeys };
}

/** A fresh demo workspace with the pipeline run (replayed from the cache after run 1). */
async function freshDemo(): Promise<string> {
  const ws = (await createDemoWorkspace(pack.id)).id;
  await runToEnd(ws, SCRIPT_RUN);
  return ws;
}

/** Recovery on a fresh demo: switch on, ladder, sample neighbour answers. Null when the pack has no samples. */
async function recoveryOnce(label: string): Promise<{ ws: string; rec: CallRecord } | null> {
  const ws = await freshDemo();
  const samples = await recoverySamples(ws);
  if (samples.answers.length === 0 && !samples.decline) {
    await purge(ws);
    return null;
  }
  const rec = startRecording();
  const t0 = Date.now();
  try {
    const r = await precomputeRecovery(ws);
    console.log(`[${label}] recovery ${ws}: ${r.gaps} gaps on the ladder, ${r.answered} sample answers, ${r.declined} declined in ${s(Date.now() - t0)}; ${calls(rec)}`);
  } finally {
    stopRecording();
  }
  return { ws, rec };
}

/** The living-handover demo path on a fresh demo. Null when the answer key has no example finding. */
async function findingOnce(label: string): Promise<{ ws: string; rec: CallRecord } | null> {
  if (!exampleFinding(pack)) return null;
  const ws = await freshDemo();
  const approver = pack.approverRole;
  const successor = pack.successorRole;
  const due = new Date(Date.parse(pack.demo!.today) + 14 * 86_400_000).toISOString().slice(0, 10);
  const must = <T extends { ok: boolean }>(what: string, r: T): Extract<T, { ok: true }> => {
    if (!r.ok) throw new Error(`${what}: ${(r as { error?: string }).error ?? "refused"}`);
    return r as Extract<T, { ok: true }>;
  };
  must("approve tier A", await bulkApprove(ws, approver));
  for (const g of await listBlockingGaps(ws)) {
    must("plan", await savePlanItem(ws, {
      responsibilityId: g.responsibilityId, checkKey: g.checkKey,
      owner: "The successor", dueDate: due, riskNote: "Known gap; checked weekly.",
    }, approver));
  }
  must("snapshot v1", await approveSnapshot(ws, approver));
  const fw = await firstWeeks(ws, successor);
  const row = [...fw.blocking, ...fw.other].find((g) => g.example && g.canRecord);
  if (!row?.example) {
    console.warn(`[${label}] finding ${ws}: the example finding's gap is not open for ${successor}; nothing to precompute`);
    await purge(ws);
    return null;
  }
  const rec = startRecording();
  const t0 = Date.now();
  try {
    const recorded = must("record finding", await recordFinding(ws, successor, {
      responsibilityId: row.responsibilityId, checkKey: row.checkKey,
      answer: row.example.answer, note: row.example.note, link: "", attachment: null, narrowRoles: null, example: true,
    }));
    const decided = must("approve finding", await decideFinding(ws, approver, recorded.findingId, "approved", {
      evidenceOpened: true, note: "Checked against the evidence.",
    }));
    console.log(
      `[${label}] finding ${ws}: ${row.responsibilityKey}.${row.checkKey} approved in ${s(Date.now() - t0)}; ${calls(rec)}; ` +
        (decided.snapshot ? `snapshot v${decided.snapshot.version} ${decided.delta ?? ""}` : `not released: ${decided.blocked ?? "no snapshot"}`),
    );
  } finally {
    stopRecording();
  }
  return { ws, rec };
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
  // The same rule for the scripted widening: prompts both runs sent replay in the demo.
  const stableWiden = [...cold.widenKeys].filter((k) => warm.widenKeys.has(k) && !keys.has(k));
  for (const k of stableWiden) keys.add(k);
  console.log(`widening re-run prompts sent by both runs (exported too): ${stableWiden.length} beyond the others`);

  // Round 3 paths: each twice on fresh workspaces; the prompts both passes sent replay in the demo.
  const extraWs: string[] = [];
  for (const [name, once] of [["recovery", recoveryOnce], ["finding", findingOnce]] as const) {
    const first = await once("run 1");
    const second = first ? await once("run 2") : null;
    if (!first || !second) {
      if (first) extraWs.push(first.ws);
      console.log(`${name}: ${first ? "second pass did not run" : "not in this pack's demo; skipped"}`);
      continue;
    }
    extraWs.push(first.ws, second.ws);
    const stable = [...first.rec.keys].filter((k) => second.rec.keys.has(k) && !keys.has(k));
    for (const k of stable) keys.add(k);
    const unstable = [...second.rec.keys].filter((k) => !first.rec.keys.has(k)).length;
    console.log(`${name}: prompts sent by both passes (exported too): ${stable.length} beyond the earlier ones; ${unstable} of the second pass did not repeat; second pass ${calls(second.rec)}`);
  }

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
    for (const w of extraWs) await purge(w);
  }
  await db().end();
  if (!sameClaims || !sameScores || !sameQuestions || !fullyCached) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
