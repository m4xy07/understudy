// Evaluation of a demo workspace against data/demo/ground_truth.json (admin read; the page
// filters what it lists by the viewing role). Pure scoring lives in ./core/evaluate.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db/client";
import { toClaim, toSegment } from "@/lib/db/mappers";
import type { Segment } from "@/lib/types";
import { evaluate, type EvalReport, type GroundTruth } from "./core/evaluate";
import type { DroppedDraft } from "./core/verify";
import { getExtraction } from "./index";

export function loadGroundTruth(root = process.cwd()): GroundTruth & { today?: string } {
  return JSON.parse(readFileSync(join(root, "data", "demo", "ground_truth.json"), "utf8"));
}

export interface WorkspaceEvaluation {
  report: EvalReport;
  groundTruth: GroundTruth;
  extractMs: number | null;
  verifyMs: number | null;
  batches: number;
  cachedBatches: number;
  failedBatches: number;
  modelNote: string | null;
}

export async function evaluateWorkspace(ws: string): Promise<WorkspaceEvaluation> {
  const sql = db();
  const groundTruth = loadGroundTruth();
  const claims = (await sql`SELECT * FROM claims WHERE workspace_id = ${ws}`).map(toClaim);
  const segRows = await sql`SELECT DISTINCT ON (id) * FROM segments WHERE workspace_id = ${ws} ORDER BY id, version DESC`;
  const segmentsById = new Map<string, Segment>(segRows.map((r) => [String(r.id), toSegment(r)]));
  const droppedRows = await sql`SELECT * FROM attest_dropped WHERE workspace_id = ${ws}`;
  const dropped: DroppedDraft[] = droppedRows.map((r) => ({
    sourceId: String(r.source_id),
    reason: String(r.reason),
    draft: {
      entity: String(r.entity),
      attribute: r.attribute as DroppedDraft["draft"]["attribute"],
      value: String(r.value),
      statement: String(r.statement),
      citations: (r.citations as { segment_id: string; quote: string | null }[]) ?? [],
      batchId: "",
      batchSegmentIds: [],
      origin: "extracted",
    },
  }));
  const ext = await getExtraction(ws);
  const report = evaluate({
    claims,
    segmentsById,
    groundTruth,
    dropped,
    firings: ext?.verification?.firings ?? [],
  });
  const batches = ext?.batches ?? [];
  return {
    report,
    groundTruth,
    extractMs: ext?.extractMs ?? null,
    verifyMs: ext?.verification?.ms ?? null,
    batches: batches.length,
    cachedBatches: batches.filter((b) => b.ok && b.cached).length,
    failedBatches: batches.filter((b) => !b.ok).length,
    modelNote: ext?.modelNote ?? null,
  };
}
