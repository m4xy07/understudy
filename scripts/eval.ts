// Evaluates Attest on a fresh demo workspace of one pack against that demo's answer key
// (<demo.dataDir>/ground_truth.json) and writes the report. Uses the model cache first
// (pnpm db:seed), then the live model. The default pack writes docs/EVALUATION.md; any other pack
// writes docs/EVALUATION.<pack>.md. Notes on the numbers come from docs/eval-notes/<pack>.md.
// Exits 1 and leaves the report alone when any extraction batch failed (--allow-failed writes it).
// The extraction prompt comes from ATTEST_PROMPT (v2 = two passes, r2 = the Round 2 prompt), then the pack.
// --scores also runs the stand-in successor for every role the pack tests and prints B, C and K
// before any answer (more model calls: the Lacuna test step).
// Usage: pnpm tsx scripts/eval.ts [--pack <id>] [--keep] [--no-write] [--no-support] [--verbose] [--allow-failed] [--scores]
import "./load-env";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db/client";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { getExtraction, reconstruct, verify } from "@/lib/attest";
import { buildInventory, runTest } from "@/lib/lacuna";
import { evaluateWorkspace } from "@/lib/attest/evaluation";
import { formatReport } from "@/lib/attest/core/evaluate";
import { modelTag } from "@/lib/model/client";
import { defaultPackId, getPack } from "@/lib/pack";

const args = new Set(process.argv.slice(2));
const packArg = process.argv.indexOf("--pack");
const pack = getPack(packArg === -1 ? defaultPackId() : (process.argv[packArg + 1] ?? ""));
if (!pack.demo) throw new Error(`Setting pack "${pack.id}" has no demo to evaluate.`);
const dataDir = pack.demo.dataDir.replace(/\\/g, "/").replace(/\/+$/, "");
const reportName = pack.id === defaultPackId() ? "EVALUATION.md" : `EVALUATION.${pack.id}.md`;

async function purge(ws: string) {
  await db().begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${ws}`;
  });
}

async function main() {
  const ws = (await createDemoWorkspace(pack.id)).id;
  try {
    const t0 = Date.now();
    const r = await reconstruct(ws);
    const t1 = Date.now();
    const v = await verify(ws, { support: !args.has("--no-support") });
    const t2 = Date.now();
    const e = await evaluateWorkspace(ws);
    const rep = e.report;
    const pct = (x: { value: number | null }) => (x.value === null ? "n/a" : (x.value * 100).toFixed(1) + "%");
    console.log(`workspace ${ws}`);
    console.log(`reconstruct ${t1 - t0} ms (${e.batches} batches, ${e.cachedBatches} cached, ${e.failedBatches} failed); verify ${t2 - t1} ms`);
    console.log(`model note: ${r.modelNote}`);
    const cons = r.consolidation;
    const consLine = cons
      ? `${cons.before} candidates -> ${cons.after} drafts; ` + Object.entries(cons.counts).map(([k, n]) => `${k} ${n}`).join(", ")
      : "off";
    console.log(`extraction prompt: ${r.variant}; consolidation: ${consLine}`);
    console.log(`verify: ${JSON.stringify(v)}`);
    console.log(`precision strict ${pct(rep.precision)} (${rep.precision.num}/${rep.precision.den}), on answer-key topics ${pct(rep.topicPrecision)} (${rep.topicPrecision.num}/${rep.topicPrecision.den}), recall ${pct(rep.recall)} (${rep.recall.num}/${rep.recall.den})`);
    console.log(`citation pass ${pct(rep.citationPassRate)}, from record ${pct(rep.fromRecordShare)}, false conflicts ${rep.falseConflicts.count}, supersessions ${rep.supersessions.found}/${rep.supersessions.expected}, planted conflicts ${rep.plantedConflicts.found}/${rep.plantedConflicts.expected}, secrets ${rep.secretsLeaked.count}, restricted ${rep.restrictedViolations.count}`);
    console.log(
      "recall per entity: " +
        Object.entries(rep.perEntity).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${k} ${x.matched}/${x.expected}`).join(", "),
    );
    const scoreLines: string[] = [];
    if (args.has("--scores")) {
      const t3 = Date.now();
      await buildInventory(ws);
      for (const role of pack.testRoles) {
        const t = await runTest(ws, role);
        const sc = t.scores;
        scoreLines.push(`${role}: B ${sc.b} \u00b7 C ${Math.round(sc.c * 100)}% \u00b7 K ${sc.k == null ? "n/a" : Math.round(sc.k * 100) + "%"}`);
      }
      console.log(`scores before answers (${Date.now() - t3} ms): ${scoreLines.join("; ")}`);
    }
    if (args.has("--verbose")) {
      for (const f of cons?.firings ?? []) console.log(`  ${f.rule} ${f.entity}/${f.attribute} = ${f.value} :: ${f.detail}`);
      for (const m of rep.supersessions.missing) console.log(`  missed supersession ${m.entity}/${m.attribute}: ${m.old} -> ${m.new}`);
      for (const m of rep.plantedConflicts.missing) console.log(`  missed planted conflict ${m.entity}/${m.attribute}: ${m.values.join(" vs ")}`);
      for (const u of rep.unmatched) console.log(`  missed ${u.id} ${u.entity}/${u.attribute} = ${u.value}`);
      for (const p of rep.falseConflicts.pairs) console.log(`  false conflict ${p.entity}/${p.attribute}: ${p.values.join(" vs ")}`);
    }
    // A failed batch silently removes its claims and lowers recall: never publish such a run as the score.
    const failed = ((await getExtraction(ws))?.batches ?? []).filter((b) => !b.ok);
    if (failed.length) {
      console.error(`FAILED BATCHES: ${failed.length} of ${e.batches}; their segments have no model claims, so these scores are incomplete.`);
      for (const b of failed) console.error(`  ${b.id} ${b.thread} (${b.segmentIds.length} segments): ${b.error ?? "error"}`);
      process.exitCode = 1;
    }
    if (failed.length && !args.has("--allow-failed")) {
      console.error(`docs/${reportName} not written (pass --allow-failed to write it anyway).`);
    } else if (!args.has("--no-write")) {
      const notesFile = path.join(process.cwd(), "docs", "eval-notes", `${pack.id}.md`);
      const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8").replace(/\r\n/g, "\n").trimEnd().split("\n") : [];
      const header = [
        "# Evaluation",
        "",
        `Generated by \`pnpm tsx scripts/eval.ts\` on a fresh demo workspace (${dataDir}) against`,
        `\`${dataDir}/ground_truth.json\`. Matching: a ground-truth claim is found when a claim on the same`,
        "entity and attribute contains every keyword (src/lib/attest/core/evaluate.ts).",
        "",
        `- Model: \`${modelTag()}\` (answers replayed from \`${dataDir}/model_cache.json\` when cached)`,
        `- Extraction: ${e.batches} model batches (${e.cachedBatches} from the cache, ${e.failedBatches} failed), ${t1 - t0} ms; verify incl. support check ${t2 - t1} ms`,
        `- Extraction prompt: \`${r.variant}\` (ATTEST_PROMPT=v2|r2); consolidation: ${consLine}`,
        ...(scoreLines.length ? [`- Stand-in successor before any answer: ${scoreLines.join("; ")}`] : []),
        `- Verify: ${v.checked} claims, ${v.fromRecord} from record, ${v.corroborated} corroborated, ${v.inferred} inferred, ${v.dropped} drafts dropped, ${v.superseded} superseded, ${v.conflicting} conflicting, ${v.firings} rule firings, support check ${v.supportChecked} checked / ${v.supportLowered} lowered`,
        "",
        ...(notes.length ? [...notes, ""] : []),
        "",
      ].join("\n");
      const body = formatReport(rep).replace(/^# Attest evaluation\n\n/, "## Results\n\n");
      const file = path.join(process.cwd(), "docs", reportName);
      fs.writeFileSync(file, header + body);
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
    }
  } finally {
    if (!args.has("--keep")) await purge(ws);
    await db().end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
