// B, then C, then K. Never one percentage (docs/ARCHITECTURE.md section 4).
import type { Scores as ScoresT } from "@/lib/types";
import { OPEN_GAPS_NOTE } from "@/lib/relay/core/labels";

export function pct(x: number | null): string {
  return x === null ? "n/a" : `${Math.round(x * 100)}%`;
}

export function scoresText(s: ScoresT): string {
  return `B ${s.b} · C ${pct(s.c)} · K ${pct(s.k)}`;
}

export function ScoreLine({ scores, provisional = true }: { scores: ScoresT | null; provisional?: boolean }) {
  if (!scores) return <span className="text-muted">No test yet</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span
        className="mono text-base text-ink"
        aria-label={`B ${scores.b} blocking gaps, C ${pct(scores.c)} coverage, K ${pct(scores.k)} backed by records`}
      >
        <strong className="font-semibold">B {scores.b}</strong>
        <span aria-hidden="true"> · </span>C {pct(scores.c)}
        <span aria-hidden="true"> · </span>K {pct(scores.k)}
      </span>
      {provisional && <span className="text-xs text-muted">provisional until review</span>}
    </span>
  );
}

/**
 * Shown under the scores next to a release label. A restricted blocking gap with a named owner in the
 * continuation plan leaves B but stays open, so "N open blocking gaps" can be larger than B.
 */
export function OpenGapsNote({ b, open }: { b: number; open: number }) {
  if (open === b) return null;
  return <p className="mt-1 text-sm text-muted">{OPEN_GAPS_NOTE}</p>;
}

export function ScoreLegend() {
  return (
    <p className="text-sm text-muted">
      <strong className="text-ink-2">B</strong> blocking checks not covered ·{" "}
      <strong className="text-ink-2">C</strong> weighted coverage ·{" "}
      <strong className="text-ink-2">K</strong> share of that coverage backed by records, not by what someone said
    </p>
  );
}
