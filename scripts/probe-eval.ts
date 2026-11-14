// Measures content-level confidentiality on one pack's demo and writes the results up.
//   1. a fresh demo workspace runs the pipeline; every claim is approved and a snapshot is approved
//      with a scripted continuation plan;
//   2. the classifier is scored on the labelled evaluation set (probes.json "evalSegments") in a
//      scratch workspace, once with the model off (rules only) and once with the model;
//   3. the detector check: every rewording of every planted fact is fed straight into the
//      key-term check and the model judge, to see what each one catches;
//   4. the probes run over every role and every surface of the demo workspace, with the judge;
//   5. docs/PROBE_RESULTS.md and <demo.dataDir>/probe_summary.json are written.
// Hard rewordings and the evaluation set never enter the live demo sources.
// Usage: pnpm tsx scripts/probe-eval.ts [--pack <id>] [--no-judge] [--keep]
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db/client";
import { getExtraction } from "@/lib/attest";
import { countWithheld, getLatestTestRun, listClaims } from "@/lib/db/queries";
import { listBlockingGaps, savePlanItem } from "@/lib/lacuna";
import { modelAvailable, modelTag, startRecording, stopRecording } from "@/lib/model/client";
import { defaultPackId, getPack, roleLabel } from "@/lib/pack";
import { createDemoWorkspace, createEmptyWorkspace, ingestSources } from "@/lib/pipeline/ingest";
import { executeRun, startRun } from "@/lib/pipeline/run";
import { approveSnapshot, bulkApprove, reviewClaim, runProbes } from "@/lib/relay";
import { textRevealsFact } from "@/lib/relay/core/probes";
import { demoProbeFacts } from "@/lib/relay/handover";
import { judgeText, modelJudgeCall } from "@/lib/relay/probes";
import { pct, probeSummaryPath, type ClassifierCategoryRow, type ProbeSummary } from "@/lib/relay/probe-summary";
import { CATEGORIES, CLASSIFIER_VERSION } from "@/lib/tether/sensitivity";
import type { RoleKey } from "@/lib/types";

const arg = (name: string) => process.argv.includes(name);
const packArg = process.argv.indexOf("--pack");
const pack = getPack(packArg === -1 ? defaultPackId() : (process.argv[packArg + 1] ?? ""));
if (!pack.demo) throw new Error(`Setting pack "${pack.id}" has no demo.`);
const DATA = path.join(process.cwd(), pack.demo.dataDir);
const roles = pack.roles.map((r) => r.key as RoleKey);

interface EvalSegment { id: string; author: string; text: string; thread?: string; expect: "sensitive" | "open"; category?: string; difficulty?: string }
interface ProbeFile { evalSegments?: EvalSegment[] }
interface GroundTruth {
  sensitive?: { id: string; case: string; stage: string; containsText: string }[];
}

const sql = db();
const made: string[] = [];

async function purge(ws: string) {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${ws}`;
  });
}

// ---------------------------------------------------------------------------------------------
// 1. The demo workspace, approved

async function approvedDemo() {
  const rec = startRecording();
  const t0 = Date.now();
  const { id: ws } = await createDemoWorkspace(pack.id);
  const ingestMs = Date.now() - t0;
  stopRecording();
  made.push(ws);
  const { runId } = await startRun(ws);
  const run = await executeRun(ws, runId);
  if (run?.status !== "done") console.warn(`pipeline run ${run?.status}: ${run?.error ?? ""}`);
  const approver = pack.approverRole;
  for (const g of await listBlockingGaps(ws)) {
    await savePlanItem(ws, {
      responsibilityId: g.responsibilityId, checkKey: g.checkKey, owner: roleLabel(approver, pack),
      dueDate: "2026-11-30", riskNote: "Open at handover; the approver follows up in the first week.",
    }, approver);
  }
  await bulkApprove(ws, approver);
  let approved = 0;
  for (const c of await listClaims(ws)) {
    if (c.review !== "pending" || c.state === "dropped" || c.state === "superseded") continue;
    const res = await reviewClaim(ws, c.id, "approved", approver, { evidenceOpened: true, note: "Checked against the evidence for the probe evaluation." });
    if (res.ok) approved++;
  }
  const snap = await approveSnapshot(ws, approver);
  if (!snap.ok) throw new Error(`snapshot not approved: ${snap.error}`);
  console.log(`demo ${ws}: run ${run?.status}; ${approved} claims approved one by one; snapshot v${snap.snapshot?.version} (${snap.label})`);
  return { ws, ingestMs, classifierCalls: rec.calls, classifierCached: rec.cached };
}

/** The model-call audit over the recorded extraction batches: one role set per call, no limited segment in a wider call. */
async function modelCallAudit(ws: string) {
  const ext = await getExtraction(ws);
  const segs = await sql`SELECT DISTINCT ON (id) id, role_set, sensitivity FROM segments WHERE workspace_id = ${ws} ORDER BY id, version DESC`;
  const byId = new Map(segs.map((s) => [String(s.id), s]));
  let violations = 0;
  for (const b of ext?.batches ?? []) {
    const callRoles = [...b.roleSet].sort().join(",");
    for (const id of b.segmentIds) {
      const s = byId.get(id);
      if (!s) continue;
      const own = [...(s.role_set as string[])].sort().join(",");
      if (own !== callRoles) violations++;
    }
  }
  return { calls: ext?.batches.length ?? 0, violations };
}

// ---------------------------------------------------------------------------------------------
// 2. Classifier on the evaluation set

function evalChat(items: EvalSegment[]): string {
  // One message a day, so the follow-up window never links two unrelated evaluation messages.
  const lines: string[] = [];
  items.forEach((e, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    lines.push(`${dd}/${mm}/26, 10:00 - ${e.author}: ${e.text.replace(/\s+/g, " ").trim()}`);
  });
  return lines.join("\n");
}

async function classifyEval(items: EvalSegment[], withModel: boolean) {
  const ws = await createEmptyWorkspace("probe evaluation (scratch)", pack.id);
  made.push(ws);
  const t0 = Date.now();
  const rec = startRecording();
  await ingestSources(ws, [{
    kind: "whatsapp", name: "Evaluation chat", roleSet: [...(pack.uploadDefaults.roleSet as RoleKey[])],
    files: [{ path: "Evaluation chat.txt", content: evalChat(items) }],
  }], "upload", withModel ? {} : { sensitivityCall: null });
  stopRecording();
  const rows = await sql`SELECT text, sensitivity, sensitivity_stage, role_set_original FROM segments WHERE workspace_id = ${ws}`;
  const byText = new Map(rows.map((r) => [String(r.text).replace(/\s+/g, " ").trim(), r]));
  const out = items.map((e) => {
    const r = byText.get(e.text.replace(/\s+/g, " ").trim());
    if (!r) throw new Error(`evaluation segment ${e.id} was not stored`);
    const limited = (r.sensitivity as string[]).length > 0 && r.role_set_original !== null;
    return { e, limited, stage: (r.sensitivity_stage as string | null) ?? null, categories: r.sensitivity as string[] };
  });
  return { out, ms: Date.now() - t0, calls: rec.calls };
}

// ---------------------------------------------------------------------------------------------
// Main

async function main() {
  const up = await modelAvailable();
  console.log(`model ${modelTag()}; reachable: ${up}; classifier version ${CLASSIFIER_VERSION}`);
  const facts = demoProbeFacts(pack);
  const probeFile = JSON.parse(fs.readFileSync(path.join(DATA, "probes.json"), "utf8")) as ProbeFile;
  const gt = JSON.parse(fs.readFileSync(path.join(DATA, "ground_truth.json"), "utf8")) as GroundTruth;
  const items = probeFile.evalSegments ?? [];

  const demo = await approvedDemo();
  const audit = await modelCallAudit(demo.ws);

  // Limited messages in the live demo, and the planted cases with the model off.
  const limitedRows = await sql`
    SELECT sensitivity_stage FROM segments WHERE workspace_id = ${demo.ws} AND sensitivity <> '{}' AND role_set_original IS NOT NULL AND version = 1`;
  const stageCount = (s: string[]) => limitedRows.filter((r) => s.includes(String(r.sensitivity_stage))).length;
  const off = await createDemoWorkspace(pack.id, { sensitivityCall: null });
  made.push(off.id);
  const planted = (gt.sensitive ?? []).filter((x) => x.stage === "rule");
  const cases = [...new Set(planted.map((x) => x.case))];
  let casesCaught = 0;
  for (const c of cases) {
    let all = true;
    for (const p of planted.filter((x) => x.case === c)) {
      const [r] = await sql`SELECT sensitivity_stage FROM segments WHERE workspace_id = ${off.id} AND position(${p.containsText} in text) > 0`;
      if (r?.sensitivity_stage !== "rule") all = false;
    }
    if (all) casesCaught++;
  }

  // Classifier.
  const rulesOnly = await classifyEval(items, false);
  const full = await classifyEval(items, true);
  const positives = full.out.filter((x) => x.e.expect === "sensitive");
  const negatives = full.out.filter((x) => x.e.expect === "open");
  const tp = positives.filter((x) => x.limited).length;
  const fp = negatives.filter((x) => x.limited).length;
  const rows: ClassifierCategoryRow[] = CATEGORIES.map((category) => {
    const pos = positives.filter((x) => x.e.category === category);
    return {
      category,
      planted: pos.length,
      byRule: pos.filter((x) => x.limited && (x.stage === "rule" || x.stage === "follow")).length,
      byModel: pos.filter((x) => x.limited && x.stage === "model").length,
      held: pos.filter((x) => x.limited && x.stage === "held").length,
      missed: pos.filter((x) => !x.limited).length,
      wronglyLimited: negatives.filter((x) => x.limited && x.categories[0] === category).length,
    };
  });
  const rulePositives = rulesOnly.out.filter((x) => x.e.expect === "sensitive" && x.limited && (x.stage === "rule" || x.stage === "follow")).length;
  const classifier: ProbeSummary["classifier"] = {
    segments: items.length,
    positives: positives.length,
    negatives: negatives.length,
    rows,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: positives.length ? tp / positives.length : null,
    recallRulesOnly: positives.length ? rulePositives / positives.length : null,
    heldModelOff: rulesOnly.out.filter((x) => x.stage === "held").length,
    wronglyLimited: fp,
    primaryCases: { caught: casesCaught, of: cases.length },
    missed: positives.filter((x) => !x.limited).map((x) => ({ id: x.e.id, category: x.e.category ?? "", difficulty: x.e.difficulty ?? "", text: x.e.text })),
    wronglyLimitedItems: negatives.filter((x) => x.limited).map((x) => ({ id: x.e.id, text: x.e.text, stage: x.stage ?? "" })),
    modelCalls: full.calls,
    ms: full.ms,
  };
  console.log(`classifier: precision ${pct(classifier.precision)}, recall ${pct(classifier.recall)} (rules only ${pct(classifier.recallRulesOnly)}), ` +
    `${fp} wrongly limited, ${classifier.missed.length} missed, ${classifier.heldModelOff} held with the model off; primary cases ${casesCaught} of ${cases.length}`);

  // Detector check.
  const useJudge = !arg("--no-judge");
  const judge = modelJudgeCall({ cacheOnly: () => !up });
  const detector: ProbeSummary["detector"] = {
    rewordings: 0, keyTerms: 0, judgeOnly: 0, neither: 0, judgeAsked: false, missed: [],
    catchable: { total: 0, keyTerms: 0 }, hard: { total: 0, keyTerms: 0, judgeOnly: 0, neither: 0 },
  };
  for (const f of facts) {
    const list: { text: string; kind: "rewording" | "hard" }[] = [
      ...(f.rewordings ?? []).map((text) => ({ text, kind: "rewording" as const })),
      ...(f.hardRewordings ?? []).map((text) => ({ text, kind: "hard" as const })),
    ];
    for (const r of list) {
      detector.rewordings++;
      const surface = `Notes for the week.\n${r.text}\nSee the board for dates.`;
      const byTerms = textRevealsFact(surface, f);
      let byJudge = false;
      if (!byTerms && useJudge) {
        const answers = await judgeText([f], "detector", surface, judge);
        if (answers !== null) detector.judgeAsked = true;
        // The same rule as the grid: the quote is in the text and the judge's second look stands by it.
        byJudge = (answers ?? []).some((a) => a.verified === true);
      }
      if (r.kind === "rewording") {
        detector.catchable.total++;
        if (byTerms) detector.catchable.keyTerms++;
      } else {
        detector.hard.total++;
        if (byTerms) detector.hard.keyTerms++;
        else if (byJudge) detector.hard.judgeOnly++;
        else detector.hard.neither++;
      }
      if (byTerms) detector.keyTerms++;
      else if (byJudge) detector.judgeOnly++;
      else {
        detector.neither++;
        detector.missed.push({ factId: f.id, text: r.text, kind: r.kind });
      }
    }
  }
  console.log(`detector: ${detector.rewordings} rewordings; key terms ${detector.keyTerms}, judge only ${detector.judgeOnly}, neither ${detector.neither}`);

  // The grid, with the judge.
  const t1 = Date.now();
  const judgeRec = startRecording();
  const { run, report } = await runProbes(demo.ws, "script", useJudge ? { call: judge } : { judge: false });
  stopRecording();
  console.log(`grid: ${report.checks} checks, ${report.failed} fail; ${run.summary.judgeCalls} judge calls (${run.summary.judgeFailed} failed, ${run.summary.judgeWithdrawn} findings withdrawn at the second look) in ${((Date.now() - t1) / 1000).toFixed(1)} s`);

  const withheld = {} as Record<RoleKey, number>;
  for (const r of roles) withheld[r] = await countWithheld(demo.ws, r);
  const scores = {} as ProbeSummary["scores"];
  for (const r of pack.testRoles) scores[r] = (await getLatestTestRun(demo.ws, r))?.scores ?? null;

  const summary: ProbeSummary = {
    generatedAt: new Date().toISOString(),
    modelTag: modelTag(),
    pack: pack.id,
    classifier,
    detector,
    grid: {
      checks: report.checks, failed: report.failed, textsChecked: report.textsChecked,
      tokenLeaks: run.summary.tokenLeaks, probeLeaks: run.summary.probeLeaks, unconfirmed: run.summary.unconfirmed,
      judgeCalls: run.summary.judgeCalls, judgeFailed: run.summary.judgeFailed, judgeWithdrawn: run.summary.judgeWithdrawn,
      notBuilt: report.surfaces.filter((s) => !s.built).map((s) => s.label),
    },
    modelCallAudit: audit,
    withheld,
    scores,
    limited: { byRule: stageCount(["rule", "follow"]), byModel: stageCount(["model"]), held: stageCount(["held"]), total: limitedRows.length },
  };
  fs.writeFileSync(probeSummaryPath(pack)!, JSON.stringify(summary, null, 1) + "\n");
  fs.writeFileSync(path.join(process.cwd(), "docs", "PROBE_RESULTS.md"), markdown(summary, report.findings.map((f) => ({
    ...f, fact: facts.find((x) => x.id === f.item)?.fact ?? f.item,
  })), { ingestMs: demo.ingestMs, classifierCalls: demo.classifierCalls, classifierCached: demo.classifierCached }));
  console.log(`wrote ${path.relative(process.cwd(), probeSummaryPath(pack)!)} and docs/PROBE_RESULTS.md`);

  // The judge's answers for the demo's outputs go into the demo cache, so "Run probes again" in a
  // fresh copy of the demo replays what it can (texts that are the same in every copy) at once.
  if (useJudge && run.summary.judgeFailed === 0 && judgeRec.keys.size) {
    const cached = await sql<{ input_hash: string; model_tag: string; output: unknown; created_at: Date }[]>`
      SELECT input_hash, model_tag, output, created_at FROM model_cache WHERE input_hash = ANY(${[...judgeRec.keys]}::text[])`;
    const file = path.join(DATA, "model_cache.json");
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as { input_hash: string }[];
    const byHash = new Map<string, unknown>(existing.map((x) => [x.input_hash, x]));
    let added = 0;
    for (const r of cached) {
      if (byHash.has(r.input_hash)) continue;
      byHash.set(r.input_hash, { input_hash: r.input_hash, model_tag: r.model_tag, output: r.output, created_at: r.created_at.toISOString() });
      added++;
    }
    const out = [...byHash.values()].sort((a, b) => ((a as { input_hash: string }).input_hash < (b as { input_hash: string }).input_hash ? -1 : 1));
    fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
    console.log(`judge answers in the demo cache: ${added} added, ${out.length} rows in ${path.relative(process.cwd(), file)}`);
  }

  if (!arg("--keep")) for (const ws of made) await purge(ws);
  await sql.end();
  if (report.failed > 0 || audit.violations > 0 || casesCaught < cases.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------
// The write-up

function markdown(
  s: ProbeSummary,
  findings: { row: string; role: string; surface: string; item: string; by: string; quote: string; confirmed: boolean; fact: string }[],
  cost: { ingestMs: number; classifierCalls: number; classifierCached: number },
): string {
  const c = s.classifier;
  const d = s.detector;
  const label: Record<string, string> = { finance: "Money", hr: "People matter", health: "Health" };
  const role = (r: string) => roleLabel(r, pack);
  const L: string[] = [];
  L.push("# Probe results");
  L.push("");
  L.push("Restricted facts were planted in reworded form. This page shows what each check caught and what it missed.");
  L.push("");
  L.push(`Generated by \`pnpm tsx scripts/probe-eval.ts\` on ${s.generatedAt.slice(0, 16).replace("T", " ")} UTC, setting pack \`${s.pack}\`, model \`${s.modelTag}\`. ` +
    "The same numbers are shown in the app on the Probe results page (`/w/<workspace>/probes`). Do not edit by hand: run the script again.");
  L.push("");
  L.push("## Classifier");
  L.push("");
  L.push(`Scored on a labelled evaluation set of ${c.segments} messages (${c.positives} sensitive, ${c.negatives} routine) in a scratch workspace. ` +
    "The set is never part of the live demo sources.");
  L.push("");
  L.push("| Category | Planted | Caught by a rule | Caught by the model | Held | Missed | Wrongly limited |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of c.rows) L.push(`| ${label[r.category] ?? r.category} | ${r.planted} | ${r.byRule} | ${r.byModel} | ${r.held} | ${r.missed} | ${r.wronglyLimited} |`);
  L.push("");
  L.push(`Precision ${pct(c.precision)}. Recall ${pct(c.recall)}. ${c.segments} messages checked.`);
  L.push("");
  L.push(`- Recall with the rules alone (model off): ${pct(c.recallRulesOnly)}. With the model off, ${c.heldModelOff} borderline messages are held for the approver instead of being released.`);
  L.push(`- Planted cases in the open group chat caught by a rule alone: ${c.primaryCases.caught} of ${c.primaryCases.of}.`);
  L.push(`- Routine messages wrongly limited: ${c.wronglyLimited} of ${c.negatives}.`);
  for (const w of c.wronglyLimitedItems) L.push(`  - \`${w.id}\` (${w.stage}): "${w.text}"`);
  L.push(`- Classifier model calls for the evaluation set: ${c.modelCalls}, ${(c.ms / 1000).toFixed(1)} s in total.`);
  L.push("");
  L.push("## Outputs");
  L.push("");
  L.push("Every role's view of every output of the demo workspace, after the pipeline ran and a snapshot was approved.");
  L.push("");
  L.push(`- Checks (role, output and row with something to check): ${s.grid.checks}. Failing: ${s.grid.failed}.`);
  L.push(`- Exact tokens: ${s.grid.tokenLeaks} leaks. Reworded facts: ${s.grid.probeLeaks} confirmed leaks, ${s.grid.unconfirmed} unconfirmed judge findings.`);
  L.push(`- Texts checked: ${s.grid.textsChecked}. Model judge calls: ${s.grid.judgeCalls} (${s.grid.judgeFailed} could not be asked).`);
  L.push(`- The judge raised ${s.grid.judgeWithdrawn} findings that only named a person or a topic and withdrew them at its second look (one fact, one quote, yes or no). They are not leaks and are not counted.`);
  L.push(`- Model calls with a limited message in a batch for a wider role set: ${s.modelCallAudit.violations} of ${s.modelCallAudit.calls} extraction calls.`);
  if (s.grid.notBuilt.length) L.push(`- Not built in this branch, so not counted: ${s.grid.notBuilt.join(", ")}.`);
  L.push(`- Messages limited at ingest in the demo: ${s.limited.total} (${s.limited.byRule} by a rule, ${s.limited.byModel} by the model, ${s.limited.held} held).`);
  L.push("");
  L.push("Restricted items withheld per role in the approved handover (count only, as the stub shows it):");
  L.push("");
  L.push("| Role | Restricted items |");
  L.push("|---|---|");
  for (const [r, n] of Object.entries(s.withheld)) L.push(`| ${role(r)} | ${n} |`);
  L.push("");
  L.push("Scores of the tested roles (B, C, K):");
  L.push("");
  for (const [r, sc] of Object.entries(s.scores)) L.push(`- ${role(r)}: ${sc ? `B ${sc.b}, C ${pct(sc.c)}, K ${pct(sc.k)}` : "no test run"}`);
  L.push("");
  L.push("## Detector check");
  L.push("");
  L.push(`We fed ${d.rewordings} reworded leaks straight into each check to see what it catches. Key terms caught ${d.keyTerms}. ` +
    `${d.judgeAsked ? `The model judge caught ${d.judgeOnly} more.` : "The model judge was not asked in this run."} ${d.neither} got past both.`);
  L.push("");
  L.push(`- ${d.catchable.total} rewordings use at least some of a fact's key terms: key terms caught ${d.catchable.keyTerms} (${pct(d.catchable.total ? d.catchable.keyTerms / d.catchable.total : null)}).`);
  L.push(`- ${d.hard.total} hard rewordings avoid every key term on purpose: key terms caught ${d.hard.keyTerms}, the model judge caught ${d.hard.judgeOnly}, ${d.hard.neither} got past both.`);
  L.push(`- Both checks together: ${d.keyTerms + d.judgeOnly} of ${d.rewordings} (${pct(d.rewordings ? (d.keyTerms + d.judgeOnly) / d.rewordings : null)}).`);
  L.push("");
  L.push("## Findings");
  L.push("");
  if (!findings.length) L.push("No check found a restricted token or fact in any role's outputs.");
  for (const f of findings) {
    L.push(`- ${f.row === "token" ? `Token ${f.item}` : `Probe ${f.item}`} · ${role(f.role)} · ${f.surface} · caught by ${f.by === "judge" ? "model judge" : f.by === "token" ? "exact token" : "key terms"}${f.confirmed ? "" : " (unconfirmed: the judge could not point to words in the text that give the fact away)"}`);
    if (f.row === "probe") L.push(`  - Fact: ${f.fact}`);
  }
  L.push("");
  L.push("## Missed");
  L.push("");
  if (c.missed.length + d.missed.length === 0) L.push("Nothing was missed in this run.");
  else {
    L.push("Planted items no check caught, with the wording that got through.");
    L.push("");
    for (const m of c.missed) L.push(`- Classifier, ${label[m.category] ?? m.category}, ${m.difficulty === "hard" ? "no known word" : m.difficulty === "model" ? "weak words only" : "rule wording"} (\`${m.id}\`): "${m.text}"`);
    for (const m of d.missed) L.push(`- Detector check, ${m.kind === "hard" ? "avoids every key term" : "reworded"} (\`${m.factId}\`): "${m.text}"`);
  }
  L.push("");
  L.push("## What we do about a miss");
  L.push("");
  L.push("A miss is fixed by the approver with \"Limit who sees this\" on the message. The change applies at once to claims and handovers, and is logged.");
  L.push("");
  L.push("## Known and accepted residue");
  L.push("");
  L.push("- A claim labelled \"Corroborated\" can owe that label to an agreeing claim the role cannot see. The value is one the role already sees, so nothing new is revealed beyond \"another source agrees\".");
  L.push("- The Test page shows \"Restricted\" per check. That a named check has evidence the role cannot open is needed for the continuation plan.");
  L.push("- A role that reads only one side of a conflict sees neither side until the approver settles it in Review. The count in its stub goes up; the topic is not shown.");
  L.push("- Text in a language or wording the lexicons do not cover is a likely miss at the rule stage. The hard items above are of that kind.");
  L.push("");
  L.push("## Cost");
  L.push("");
  L.push(`- Classifier at demo ingest: ${cost.classifierCalls} model calls (${cost.classifierCached} from the cache), ${(cost.ingestMs / 1000).toFixed(1)} s for the whole ingest.`);
  L.push("- The model judge runs only from this script and from the approver's \"Run probes again\" button, never on a page render.");
  L.push("");
  return L.join("\n");
}

main().catch(async (err) => {
  console.error(err);
  for (const ws of made) await purge(ws).catch(() => {});
  process.exit(1);
});
