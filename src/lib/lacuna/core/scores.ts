// B, C, K (ARCHITECTURE section 4). Computed in code only; the UI shows B, then C, then K.
import type { CheckDef, CheckResult, Coverage, Scores, Trust } from "@/lib/types";
import { findCheck } from "./checks";
import { gapKey, RECORD_TRUST, TRUST_LABEL } from "./pack";

const S: Record<Exclude<Coverage, "restricted">, number> = {
  covered: 1,
  partial: 0.5,
  missing: 0,
  conflicting: 0,
};

/**
 * s = covered 1, partial 0.5, missing/conflicting 0; restricted leaves C and K.
 * B = blocking checks not covered (missing, partial, conflicting, or restricted without a named owner).
 * C = Σw·s / Σw. K = Σw·s over checks whose bestTrust is from_record or corroborated / Σw·s (null when 0).
 * @param namedOwners gap keys ("<responsibilityId>|<checkKey>") whose restricted check has an authorised owner.
 */
export function computeScores(
  results: readonly CheckResult[],
  checksByResp: Record<string, readonly CheckDef[]>,
  namedOwners: ReadonlySet<string> = new Set(),
): Scores {
  let b = 0;
  let sumW = 0;
  let sumWS = 0;
  let sumWSRecord = 0;
  for (const r of results) {
    const check = findCheck(checksByResp, r.responsibilityId, r.checkKey);
    if (!check) continue; // a result for a check the pack no longer has: cannot be weighed
    const w = check.weight;
    const blocking = w === 5;
    if (r.coverage === "restricted") {
      if (blocking && !namedOwners.has(gapKey(r.responsibilityId, r.checkKey))) b++;
      continue;
    }
    if (blocking && r.coverage !== "covered") b++;
    const s = S[r.coverage];
    sumW += w;
    sumWS += w * s;
    if (r.bestTrust !== null && RECORD_TRUST.has(r.bestTrust)) sumWSRecord += w * s;
  }
  return {
    b,
    c: sumW === 0 ? 0 : sumWS / sumW,
    k: sumWS === 0 ? null : sumWSRecord / sumWS,
  };
}

/**
 * What the coverage rests on, by trust label: Σ w·s over checks whose bestTrust is that label,
 * divided by the total Σ w·s. The from_record and corroborated shares sum to K, so this is K
 * broken open, not a new score. Display only. Empty when nothing is covered.
 */
export function evidenceMix(
  results: readonly CheckResult[],
  checksByResp: Record<string, readonly CheckDef[]>,
): Partial<Record<Trust, number>> {
  const sums = new Map<Trust, number>();
  let total = 0;
  for (const r of results) {
    if (r.coverage === "restricted" || r.bestTrust === null) continue;
    const check = findCheck(checksByResp, r.responsibilityId, r.checkKey);
    if (!check) continue;
    const ws = check.weight * S[r.coverage];
    if (ws === 0) continue;
    total += ws;
    sums.set(r.bestTrust, (sums.get(r.bestTrust) ?? 0) + ws);
  }
  const out: Partial<Record<Trust, number>> = {};
  if (total === 0) return out;
  for (const [trust, ws] of sums) out[trust] = ws / total;
  return out;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** "B 7 · C 52% · K 88%" (K "n/a" when null). */
export function formatScores(s: Scores): string {
  return `B ${s.b} · C ${pct(s.c)} · K ${s.k === null ? "n/a" : pct(s.k)}`;
}

export interface ScoredRun {
  scores: Scores;
  results: readonly CheckResult[];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Re-test explanation, e.g.
 * "B 7 → 3: 4 blocking checks now covered by Leaver said answers · C 52% → 71% · K 88% → 64%".
 */
export function scoreDelta(
  before: ScoredRun,
  after: ScoredRun,
  checksByResp: Record<string, readonly CheckDef[]>,
): string {
  const prev = new Map(before.results.map((r) => [`${r.responsibilityId}|${r.checkKey}`, r]));
  const newlyCovered = after.results.filter((r) => {
    if (r.coverage !== "covered") return false;
    const check = findCheck(checksByResp, r.responsibilityId, r.checkKey);
    if (!check || check.weight !== 5) return false;
    return prev.get(`${r.responsibilityId}|${r.checkKey}`)?.coverage !== "covered";
  });

  const parts: string[] = [];
  const b0 = before.scores.b;
  const b1 = after.scores.b;
  if (b0 === b1) {
    parts.push(`B ${b1} (no change)`);
  } else {
    let why = "";
    if (newlyCovered.length > 0) {
      const byTrust = new Map<string, number>();
      for (const r of newlyCovered) {
        const label = r.bestTrust ? TRUST_LABEL[r.bestTrust] : "unrated";
        byTrust.set(label, (byTrust.get(label) ?? 0) + 1);
      }
      const sources = [...byTrust.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, n]) => (byTrust.size === 1 ? `${label} answers` : `${n} by ${label}`));
      why = byTrust.size === 1
        ? `: ${plural(newlyCovered.length, "blocking check", "blocking checks")} now covered by ${sources[0]}`
        : `: ${plural(newlyCovered.length, "blocking check", "blocking checks")} now covered (${sources.join(", ")})`;
    }
    parts.push(`B ${b0} → ${b1}${why}`);
  }
  // Compare what is shown: a change that rounds to the same percentage reads as no change.
  parts.push(pct(before.scores.c) === pct(after.scores.c) ? `C ${pct(after.scores.c)}` : `C ${pct(before.scores.c)} → ${pct(after.scores.c)}`);
  const k = (v: number | null) => (v === null ? "n/a" : pct(v));
  parts.push(k(before.scores.k) === k(after.scores.k) ? `K ${k(after.scores.k)}` : `K ${k(before.scores.k)} → ${k(after.scores.k)}`);
  return parts.join(" · ");
}
