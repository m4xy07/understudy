// What changed between two snapshots, and why the scores moved (living handover). Pure.
// Every sentence here is fixed text chosen by code from the two test runs: no model writes any
// of it. The record holds ids, numbers and these sentences only, never a statement or a value.
import { findCheck } from "@/lib/lacuna/core/checks";
import { formatScores, pct, scoreDelta, type ScoredRun } from "@/lib/lacuna/core/scores";
import { RECORD_TRUST, TRUST_LABEL } from "@/lib/trust";
import type { CheckDef, CheckResult, Coverage, Scores, Trust } from "@/lib/types";
import { diffSnapshots, type SnapshotDiff, type SnapshotPayload } from "./snapshot";

export type { ScoredRun };

export interface GapRef {
  responsibilityId: string;
  checkKey: string;
  /** Weight 5: the check counts toward B. */
  blocking: boolean;
  /** Coverage before and after the change. */
  from: Coverage | null;
  to: Coverage | null;
  /** Strongest trust behind the check after the change (null when nothing covers it). */
  trust: Trust | null;
  /** Claims the reading relied on (after for a closed gap, before and after for an opened one). */
  claimIds: string[];
}

const keyOf = (r: Pick<CheckResult, "responsibilityId" | "checkKey">) => `${r.responsibilityId}|${r.checkKey}`;

/**
 * Gaps closed (not covered before, covered now) and opened (covered before, not covered now)
 * between two runs of the same role. Checks the pack no longer has are skipped.
 */
export function gapChanges(
  before: readonly CheckResult[],
  after: readonly CheckResult[],
  checks: Record<string, readonly CheckDef[]>,
): { closed: GapRef[]; opened: GapRef[] } {
  const prev = new Map(before.map((r) => [keyOf(r), r]));
  const closed: GapRef[] = [];
  const opened: GapRef[] = [];
  for (const r of after) {
    const check = findCheck(checks, r.responsibilityId, r.checkKey);
    const old = prev.get(keyOf(r));
    if (!check || !old) continue;
    const ref = (claimIds: string[]): GapRef => ({
      responsibilityId: r.responsibilityId, checkKey: r.checkKey, blocking: check.weight === 5,
      from: old.coverage, to: r.coverage, trust: r.bestTrust, claimIds: [...new Set(claimIds)].sort(),
    });
    if (old.coverage !== "covered" && r.coverage === "covered") closed.push(ref(r.claimIds));
    else if (old.coverage === "covered" && r.coverage !== "covered") opened.push(ref([...old.claimIds, ...r.claimIds]));
  }
  const order = (a: GapRef, b: GapRef) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
  return { closed: closed.sort(order), opened: opened.sort(order) };
}

export interface TrustChange {
  claimId: string;
  from: Trust;
  to: Trust;
}

/** How one claim that is in both snapshots changed: its trust label, or its text (a reviewer's edit). */
export interface ClaimChange {
  claimId: string;
  kind: "trust" | "text";
  from?: Trust;
  to?: Trust;
}

export function claimChanges(prev: SnapshotPayload | null, next: SnapshotPayload, changedIds: readonly string[]): ClaimChange[] {
  const before = new Map((prev?.claims ?? []).map((c) => [c.id, c]));
  const after = new Map(next.claims.map((c) => [c.id, c]));
  const out: ClaimChange[] = [];
  for (const id of changedIds) {
    const a = before.get(id);
    const b = after.get(id);
    if (!a || !b) continue;
    if (a.trust !== b.trust) out.push({ claimId: id, kind: "trust", from: a.trust, to: b.trust });
    else out.push({ claimId: id, kind: "text" });
  }
  return out;
}

const k = (v: number | null) => (v === null ? "n/a" : pct(v));
const n1 = (n: number, one: string, many: string) => (n === 1 ? one : many).replace("{n}", String(n));

export const REASONS = {
  bDownFinding: (n: number) => n1(n, "{n} blocking gap is now covered by a successor finding.", "{n} blocking gaps are now covered by successor findings."),
  bDownRecord: (n: number) => n1(n, "{n} blocking gap is now covered by a record.", "{n} blocking gaps are now covered by records."),
  bDown: (n: number) => n1(n, "{n} blocking gap is now covered.", "{n} blocking gaps are now covered."),
  bUpConflict: (n: number) => n1(n,
    "A new answer disagrees with an existing claim, so {n} blocking check is conflicting again.",
    "A new answer disagrees with an existing claim, so {n} blocking checks are conflicting again."),
  bUp: (n: number) => n1(n, "{n} blocking check is no longer covered.", "{n} blocking checks are no longer covered."),
  cUp: (n: number) => n1(n, "{n} more check is covered.", "{n} more checks are covered."),
  cDown: (n: number) => n1(n, "{n} check is no longer covered.", "{n} checks are no longer covered."),
  kFinding: "K counts only covered work that a record backs. A finding is a person's word, so it raises C and not K.",
  kCorroborated: "A record now agrees with a finding, so that work counts as backed by a record.",
  kNone: "K is n/a because nothing is covered yet.",
} as const;

export interface ScoreLines {
  b: string;
  c: string;
  k: string;
}

function withReason(line: string, reason: string | null): string {
  return reason ? `${line} ${reason}` : line;
}

/**
 * One sentence each for B, C and K: "B went from 5 to 4. 1 blocking gap is now covered by a
 * successor finding." Percentages are compared as shown (whole per cent), so a line never says
 * "went from 66% to 66%". `before` is null for the first version.
 */
export function explainScores(
  before: Pick<ScoredRun, "scores"> | null,
  after: Pick<ScoredRun, "scores">,
  closed: readonly GapRef[],
  opened: readonly GapRef[],
  trustChanges: readonly TrustChange[] = [],
): ScoreLines {
  const a = after.scores;
  if (!before) {
    return {
      b: `B is ${a.b}.`,
      c: `C is ${pct(a.c)}.`,
      k: a.k === null ? REASONS.kNone : `K is ${pct(a.k)}.`,
    };
  }
  const p = before.scores;
  const byFinding = (g: GapRef) => g.trust === "successor_found";
  const closedBlocking = closed.filter((g) => g.blocking);
  const openedBlocking = opened.filter((g) => g.blocking);

  let b: string;
  if (a.b === p.b) b = `B stayed at ${a.b}.`;
  else if (a.b < p.b) {
    const n = closedBlocking.length || p.b - a.b;
    const reason = closedBlocking.length === 0 ? REASONS.bDown(n)
      : closedBlocking.every(byFinding) ? REASONS.bDownFinding(n)
        : closedBlocking.every((g) => g.trust !== null && RECORD_TRUST.has(g.trust)) ? REASONS.bDownRecord(n)
          : REASONS.bDown(n);
    b = withReason(`B went from ${p.b} to ${a.b}.`, reason);
  } else {
    const n = openedBlocking.length || a.b - p.b;
    const conflicting = openedBlocking.length > 0 && openedBlocking.every((g) => g.to === "conflicting");
    b = withReason(`B went from ${p.b} to ${a.b}.`, conflicting ? REASONS.bUpConflict(n) : REASONS.bUp(n));
  }

  let c: string;
  if (pct(a.c) === pct(p.c)) c = `C stayed at ${pct(a.c)}.`;
  else if (a.c > p.c) c = withReason(`C went from ${pct(p.c)} to ${pct(a.c)}.`, closed.length ? REASONS.cUp(closed.length) : null);
  else c = withReason(`C went from ${pct(p.c)} to ${pct(a.c)}.`, opened.length ? REASONS.cDown(opened.length) : null);

  const corroborated = trustChanges.some((t) => t.from === "successor_found" && t.to === "corroborated");
  let kLine: string;
  if (a.k === null) kLine = REASONS.kNone;
  else if (k(a.k) === k(p.k)) kLine = `K stayed at ${k(a.k)}.`;
  else {
    const up = p.k === null || a.k > p.k;
    const reason = up
      ? corroborated ? REASONS.kCorroborated : null
      : closed.some(byFinding) ? REASONS.kFinding : null;
    kLine = withReason(`K went from ${k(p.k)} to ${k(a.k)}.`, reason);
  }
  return { b, c, k: kLine };
}

export type ChangeCause =
  | { type: "first"; findingIds: string[] }
  | { type: "finding"; findingIds: string[] }
  | { type: "manual"; findingIds: string[] };

export interface SnapshotChangeRecord {
  diff: SnapshotDiff;
  gapsClosed: GapRef[];
  gapsOpened: GapRef[];
  claimChanges: ClaimChange[];
  /** "B 5 → 4: 1 blocking check now covered by Successor found answers · C 62% → 66% · K 88% → 84%". */
  deltaText: string;
  lines: ScoreLines;
  cause: ChangeCause;
}

/** Short form for buttons and messages: "B 5 → 4." or "B stayed at 4." */
export function shortDelta(before: Scores | null, after: Scores): string {
  if (!before) return `B ${after.b}.`;
  return before.b === after.b ? `B stayed at ${after.b}.` : `B ${before.b} → ${after.b}.`;
}

/**
 * The stored record for one snapshot: the claim diff of the two payloads, the gaps closed and
 * opened between the two successor runs, and the B, C and K sentences. Scores in the sentences
 * are the scores of the runs the two snapshots were built on, which are the scores they hashed.
 */
export function buildChangeRecord(input: {
  prev: SnapshotPayload | null;
  next: SnapshotPayload;
  before: ScoredRun | null;
  after: ScoredRun;
  checks: Record<string, readonly CheckDef[]>;
  cause: ChangeCause;
}): SnapshotChangeRecord {
  const diff = diffSnapshots(input.prev, input.next);
  const { closed, opened } = input.before
    ? gapChanges(input.before.results, input.after.results, input.checks)
    : { closed: [], opened: [] };
  const changes = claimChanges(input.prev, input.next, diff.changed);
  const trustChanges = changes
    .filter((c): c is ClaimChange & { from: Trust; to: Trust } => c.kind === "trust" && !!c.from && !!c.to)
    .map((c) => ({ claimId: c.claimId, from: c.from, to: c.to }));
  return {
    diff,
    gapsClosed: closed,
    gapsOpened: opened,
    claimChanges: changes,
    deltaText: input.before ? scoreDelta(input.before, input.after, input.checks) : formatScores(input.after.scores),
    lines: explainScores(input.before, input.after, closed, opened, trustChanges),
    cause: input.cause,
  };
}

/** "Trust went from Successor found to Corroborated." */
export function trustSentence(from: Trust, to: Trust): string {
  return `Trust went from ${TRUST_LABEL[from]} to ${TRUST_LABEL[to]}.`;
}
