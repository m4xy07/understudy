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
      {/* aria-label is not allowed on a plain span, so the full sentence is hidden text and the short form is for the eye. */}
      <span className="sr-only">
        {`B ${scores.b} blocking gaps, C ${pct(scores.c)} coverage, K ${pct(scores.k)} backed by records`}
      </span>
      <span className="mono text-base text-ink" aria-hidden="true">
        <strong className="font-semibold">B {scores.b}</strong> · C {pct(scores.c)} · K {pct(scores.k)}
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
  const owned = open - b;
  // Body-size text: this line explains why two numbers on screen differ.
  return (
    <p className="mt-2 max-w-2xl text-base text-ink-2" data-testid="open-gaps-note">
      {owned > 0
        ? `${open} blocking gaps are open and B is ${b}. ${owned === 1 ? "One gap is" : `${owned} gaps are`} restricted for the successor and ${owned === 1 ? "has" : "have"} a named owner in the continuation plan: still open, not counted in B.`
        : OPEN_GAPS_NOTE}
    </p>
  );
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
