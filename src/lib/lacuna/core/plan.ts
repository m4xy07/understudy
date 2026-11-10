// Continuation plan and the release rule (ARCHITECTURE section 4, "Continuation plan";
// Relay's release rule). Every open blocking gap needs an owner, a due date and a risk note.
import type { CheckDef, CheckResult, Coverage, PlanItem, Scores } from "@/lib/types";
import { findCheck } from "./checks";
import { gapKey } from "./pack";

export interface BlockingGap {
  responsibilityId: string;
  checkKey: string;
  coverage: Exclude<Coverage, "covered">;
}

/** Blocking (weight 5) checks that are not covered, restricted ones included. */
export function openBlockingGaps(
  results: readonly CheckResult[],
  checks: Record<string, readonly CheckDef[]>,
): BlockingGap[] {
  const out: BlockingGap[] = [];
  for (const r of results) {
    if (r.coverage === "covered") continue;
    const check = findCheck(checks, r.responsibilityId, r.checkKey);
    if (!check || check.weight !== 5) continue;
    out.push({ responsibilityId: r.responsibilityId, checkKey: r.checkKey, coverage: r.coverage });
  }
  return out;
}

export type PlanField = "owner" | "due date" | "risk note";

export interface PlanValidation {
  complete: boolean;
  incomplete: { gap: BlockingGap; lacks: PlanField[] }[];
}

function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
}

/** Which open blocking gaps lack an owner, a due date or a risk note. */
export function validatePlan(gaps: readonly BlockingGap[], planItems: readonly PlanItem[]): PlanValidation {
  const byKey = new Map(planItems.map((p) => [gapKey(p.responsibilityId, p.checkKey), p]));
  const incomplete: PlanValidation["incomplete"] = [];
  for (const gap of gaps) {
    const item = byKey.get(gapKey(gap.responsibilityId, gap.checkKey));
    const lacks: PlanField[] = [];
    if (!item?.owner?.trim()) lacks.push("owner");
    if (!item?.dueDate?.trim() || !isIsoDate(item.dueDate.trim())) lacks.push("due date");
    if (!item?.riskNote?.trim()) lacks.push("risk note");
    if (lacks.length > 0) incomplete.push({ gap, lacks });
  }
  return { complete: incomplete.length === 0, incomplete };
}

/** Gap keys of restricted checks whose plan item names an owner (feeds computeScores' namedOwners). */
export function namedOwnersFromPlan(gaps: readonly BlockingGap[], planItems: readonly PlanItem[]): Set<string> {
  const owned = new Set(planItems.filter((p) => p.owner?.trim()).map((p) => gapKey(p.responsibilityId, p.checkKey)));
  return new Set(
    gaps.filter((g) => g.coverage === "restricted").map((g) => gapKey(g.responsibilityId, g.checkKey)).filter((k) => owned.has(k)),
  );
}

export interface ReleaseState {
  canApprove: boolean;
  openBlocking: number;
  label: string;
}

function gapsWord(n: number): string {
  return n === 1 ? "blocking gap" : "blocking gaps";
}

/**
 * Release rule: B > 0 cannot be approved until every open blocking gap has owner, due date and risk note;
 * then "Released with N open blocking gaps", never complete.
 */
export function releaseState(scores: Scores, gaps: readonly BlockingGap[], plan: readonly PlanItem[]): ReleaseState {
  if (scores.b === 0 && gaps.length === 0) {
    return { canApprove: true, openBlocking: 0, label: "Ready to release" };
  }
  const v = validatePlan(gaps, plan);
  if (gaps.length > 0 && v.complete) {
    return { canApprove: true, openBlocking: gaps.length, label: `Released with ${gaps.length} open ${gapsWord(gaps.length)}` };
  }
  // B > 0 with no gap list (inconsistent inputs) is treated as unplanned.
  const n = gaps.length > 0 ? v.incomplete.length : scores.b;
  return {
    canApprove: false,
    openBlocking: Math.max(gaps.length, scores.b),
    label: `Blocked: ${n} ${gapsWord(n)} ${n === 1 ? "needs" : "need"} an owner, a due date and a risk note`,
  };
}
