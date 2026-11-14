// Prints what one pack's demo looks like after a run, as JSON: segments, claims by state and trust,
// the evaluation against the answer key, B, C and K for every tested role, the successor's blocking
// gaps next to the planted ones, the open questions, and (with --recovery) the ladder: which people
// are asked, skipped or have no role for each gap, which steps have a sample answer, and the
// before and after panel once the samples are applied.
// With --measure-leaver it also runs measureLeaverRun on a second fresh demo (the leaver answers
// every open question with the demo's sample leaver answers) and prints the stored-run shape that
// <demo.dataDir>/recovery.json keeps under "withLeaver"; --write-leaver writes it into that file.
// Usage: pnpm tsx scripts/demo-state.ts [--pack <id>] [--ws <workspace id>] [--recovery] [--measure-leaver] [--write-leaver] [--out file.json] [--keep]
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db/client";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { runToEnd, SCRIPT_RUN } from "@/lib/pipeline/run";
import { evaluateWorkspace } from "@/lib/attest/evaluation";
import {
  listBlockingGaps, listQuestions, precomputeRecovery, recoverySamples, measureLeaverRun, recoveryComparison, listLadder, listTraces,
} from "@/lib/lacuna";
import { getLatestTestRun, listResponsibilities } from "@/lib/db/queries";
import { startRecording, stopRecording } from "@/lib/model/client";
import { defaultPackId, getPack } from "@/lib/pack";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
};
const has = (name: string) => process.argv.includes(name);
const pack = getPack(arg("--pack") ?? defaultPackId());
if (!pack.demo) throw new Error(`Setting pack "${pack.id}" has no demo.`);
const dataDir = path.join(process.cwd(), pack.demo.dataDir);

async function purge(ws: string) {
  await db().begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${ws}`;
  });
}

const count = (rows: Record<string, unknown>[], key: string) =>
  Object.fromEntries([...new Set(rows.map((r) => String(r[key])))].sort().map((v) => [v, rows.filter((r) => String(r[key]) === v).length]));

interface PlantedGap { responsibility: string; checkKey: string; coverage: string; blocking: boolean }
interface PlantedResp { key?: string; entities?: string[] }

async function main() {
  const given = arg("--ws");
  const made: string[] = [];
  let ws = given ?? "";
  let pipeline: unknown = null;
  if (!given) {
    ws = (await createDemoWorkspace(pack.id)).id;
    made.push(ws);
    const rec = startRecording();
    const run = await runToEnd(ws, SCRIPT_RUN);
    stopRecording();
    pipeline = { run: run?.status, calls: rec.calls, cached: rec.cached, live: rec.live, failed: rec.failed };
  }
  const successor = pack.successorRole;
  const resps = await listResponsibilities(ws);
  const respById = new Map(resps.map((r) => [r.id, r]));
  const gt = JSON.parse(fs.readFileSync(path.join(dataDir, "ground_truth.json"), "utf8")) as { gaps?: PlantedGap[]; responsibilities?: PlantedResp[] };
  // A planted responsibility is the n-th of the answer key ("R01" is the first); it is matched to the
  // workspace's responsibility by a shared entity.
  const plantedEntities = (key: string) => {
    const list = gt.responsibilities ?? [];
    const r = list.find((x) => x.key === key) ?? list[Number(key.replace(/\D/g, "")) - 1];
    return r?.entities ?? [];
  };

  const segments = await db()`SELECT id, role_set_original, sensitivity_stage FROM segments WHERE workspace_id = ${ws}`;
  const claims = await db()`SELECT state, trust, tier, origin FROM claims WHERE workspace_id = ${ws}`;
  const live = claims.filter((c) => c.state !== "dropped");
  const evaluation = (await evaluateWorkspace(ws)).report;
  const scores: Record<string, unknown> = {};
  for (const role of pack.testRoles) scores[role] = (await getLatestTestRun(ws, role))?.scores ?? null;

  const blocking = (await listBlockingGaps(ws)).map((g) => ({
    responsibility: g.responsibilityKey, title: g.responsibilityTitle, entities: respById.get(g.responsibilityId)?.entities ?? [],
    checkKey: g.checkKey, coverage: g.coverage,
  }));
  const planted = (gt.gaps ?? []).filter((g) => g.blocking).map((g) => ({ ...g, entities: plantedEntities(g.responsibility) }));
  const same = (a: { entities: string[]; checkKey: string }, b: { entities: string[]; checkKey: string }) =>
    a.checkKey === b.checkKey && a.entities.some((e) => b.entities.includes(e));
  const blockingMatch = {
    planted: planted.length,
    found: blocking.length,
    matched: planted.filter((p) => blocking.some((b) => same(p, b))).map((p) => `${p.entities[0]}.${p.checkKey}`),
    plantedNotOpen: planted.filter((p) => !blocking.some((b) => same(p, b))).map((p) => `${p.entities[0]}.${p.checkKey} (${p.coverage})`),
    openNotPlanted: blocking.filter((b) => !planted.some((p) => same(p, b))).map((b) => `${b.entities[0]}.${b.checkKey} (${b.coverage})`),
  };
  const questions = (await listQuestions(ws)).map((q) => ({
    rank: q.rank, entities: respById.get(q.responsibilityId)?.entities ?? [], checkKey: q.checkKey, gapType: q.gapType, weight: q.weight, text: q.text,
  }));

  const out: Record<string, unknown> = {
    pack: pack.id, workspace: ws, pipeline,
    segments: { count: segments.length, limited: segments.filter((s) => s.role_set_original).length, byStage: count(segments.filter((s) => s.role_set_original), "sensitivity_stage") },
    claims: { count: live.length, dropped: claims.length - live.length, byState: count(live, "state"), byTrust: count(live, "trust"), byTier: count(live, "tier"), byOrigin: count(live, "origin") },
    evaluation: {
      recall: evaluation.recall, precision: evaluation.precision, topicPrecision: evaluation.topicPrecision,
      citationPassRate: evaluation.citationPassRate, falseConflicts: evaluation.falseConflicts.count,
      falseConflictPairs: evaluation.falseConflicts.pairs.map((p) => `${p.entity}/${p.attribute}: ${p.values.join(" vs ")}`),
      supersessions: `${evaluation.supersessions.found}/${evaluation.supersessions.expected}`,
      plantedConflicts: `${evaluation.plantedConflicts.found}/${evaluation.plantedConflicts.expected}`,
      secretsLeaked: evaluation.secretsLeaked.count, restrictedViolations: evaluation.restrictedViolations.count,
    },
    scores, successor, blocking, blockingMatch, questions,
  };

  if (has("--recovery")) {
    const samples = await recoverySamples(ws);
    const rec = startRecording();
    const r = await precomputeRecovery(ws);
    stopRecording();
    const ladder = await listLadder(ws, pack.approverRole);
    const sampleFor = (entities: string[], checkKey: string, person: string | null) =>
      samples.answers.some((s) => entities.includes(s.entity) && s.checkKey === checkKey && s.person === person);
    out.recovery = {
      switchedOn: r, modelCalls: { calls: rec.calls, cached: rec.cached, live: rec.live, failed: rec.failed },
      gaps: ladder.map((g) => {
        const entities = respById.get(g.responsibilityId)?.entities ?? [];
        return {
          rank: g.rank, entities, checkKey: g.checkKey, weight: g.weight, state: g.state, coverage: g.coverage,
          people: g.rungs[1].map((s) => `${s.personName ?? "-"} [${s.targetRole ?? "no role"}] ${s.status}${sampleFor(entities, g.checkKey, s.personName) ? " (sample)" : ""}`),
          traces: g.rungs[2].map((s) => `${s.kind} ${s.status} ${s.targetRef ?? ""}`.trim()),
          options: g.rungs[3].map((s) => `${s.kind} ${s.status}`),
        };
      }),
      rebuilt: (await listTraces(ws, pack.approverRole)).map((t) => ({
        title: t.title, kind: t.traceKind, entity: t.entity, quoted: `${t.quoted}/${t.total}`, helps: t.helps.map((h) => `${h.responsibilityKey} ${h.checkLabel}`),
      })),
      samplesWithoutAStep: samples.answers
        .filter((s) => !ladder.some((g) => (respById.get(g.responsibilityId)?.entities ?? []).includes(s.entity) && g.checkKey === s.checkKey && g.rungs[1].some((x) => x.personName === s.person && x.kind === "neighbour" && x.status !== "skipped_no_access" && x.status !== "no_seat")))
        .map((s) => `${s.entity}.${s.checkKey} ${s.person}`),
      panel: await recoveryComparison(ws),
      scoresAfterSamples: (await getLatestTestRun(ws, successor))?.scores ?? null,
    };
  }

  if (has("--measure-leaver") || has("--write-leaver")) {
    const scratch = (await createDemoWorkspace(pack.id)).id;
    made.push(scratch);
    await runToEnd(scratch, SCRIPT_RUN);
    const rec = startRecording();
    const stored = await measureLeaverRun(scratch);
    stopRecording();
    out.withLeaver = stored;
    out.withLeaverCalls = { calls: rec.calls, cached: rec.cached, live: rec.live, failed: rec.failed };
    if (stored && has("--write-leaver")) {
      const file = path.join(dataDir, "recovery.json");
      const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      json.withLeaver = stored;
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    }
  }

  console.log(JSON.stringify(out, null, 2));
  const file = arg("--out");
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  if (!has("--keep")) for (const w of made) await purge(w);
  await db().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
