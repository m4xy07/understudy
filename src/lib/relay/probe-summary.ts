// The committed numbers of the last probe evaluation (scripts/probe-eval.ts writes them to
// <demo.dataDir>/probe_summary.json). The Probe results page reads them from here: the evaluation
// set is never in a visitor's workspace, so the classifier numbers cannot be computed live.
import fs from "node:fs";
import path from "node:path";
import type { ResolvedPack } from "@/lib/pack";
import type { RoleKey } from "@/lib/types";

export interface ClassifierCategoryRow {
  category: string;
  planted: number;
  byRule: number;
  byModel: number;
  held: number;
  missed: number;
  wronglyLimited: number;
}

export interface ProbeSummary {
  generatedAt: string;
  modelTag: string;
  pack: string;
  classifier: {
    segments: number;
    positives: number;
    negatives: number;
    rows: ClassifierCategoryRow[];
    precision: number | null;
    recall: number | null;
    recallRulesOnly: number | null;
    heldModelOff: number;
    wronglyLimited: number;
    primaryCases: { caught: number; of: number };
    /** Planted items no stage caught, with the wording that got through. */
    missed: { id: string; category: string; difficulty: string; text: string }[];
    wronglyLimitedItems: { id: string; text: string; stage: string }[];
    modelCalls: number;
    ms: number;
  };
  detector: {
    rewordings: number;
    keyTerms: number;
    judgeOnly: number;
    neither: number;
    judgeAsked: boolean;
    missed: { factId: string; text: string; kind: "rewording" | "hard" }[];
    catchable: { total: number; keyTerms: number };
    hard: { total: number; keyTerms: number; judgeOnly: number; neither: number };
  };
  grid: {
    checks: number;
    failed: number;
    textsChecked: number;
    tokenLeaks: number;
    probeLeaks: number;
    unconfirmed: number;
    judgeCalls: number;
    judgeFailed: number;
    judgeWithdrawn: number;
    notBuilt: string[];
  };
  modelCallAudit: { calls: number; violations: number };
  withheld: Record<RoleKey, number>;
  scores: Record<RoleKey, { b: number; c: number; k: number | null } | null>;
  limited: { byRule: number; byModel: number; held: number; total: number };
}

const cache = new Map<string, ProbeSummary | null>();

export function probeSummaryPath(pack: Pick<ResolvedPack, "demo">): string | null {
  return pack.demo ? path.join(process.cwd(), pack.demo.dataDir, "probe_summary.json") : null;
}

/** The committed evaluation numbers of a pack's demo, or null when the script has not been run. */
export function loadProbeSummary(pack: Pick<ResolvedPack, "id" | "demo">): ProbeSummary | null {
  if (cache.has(pack.id)) return cache.get(pack.id) ?? null;
  let out: ProbeSummary | null = null;
  try {
    const file = probeSummaryPath(pack);
    if (file && fs.existsSync(file)) out = JSON.parse(fs.readFileSync(file, "utf8")) as ProbeSummary;
  } catch {
    out = null;
  }
  cache.set(pack.id, out);
  return out;
}

export const pct = (x: number | null | undefined): string => (x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`);
