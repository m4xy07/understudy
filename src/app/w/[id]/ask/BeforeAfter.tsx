// The before and after panel: what closes if the leaver answers, and what closed without them.
// Scores and counts only. Every trust label carries its symbol chip, never colour alone.
import { TrustChip } from "@/components/chips";
import { pct } from "@/components/Scores";
import type { RecoveryComparison } from "@/lib/lacuna";
import { TRUST_ORDER } from "@/lib/trust";
import type { Trust } from "@/lib/types";

function Mix({ mix }: { mix: Partial<Record<Trust, number>> }) {
  const parts = TRUST_ORDER.filter((t) => (mix[t] ?? 0) > 0);
  if (parts.length === 0) return <span className="text-muted">Nothing covered yet</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {parts.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 whitespace-nowrap">
          <TrustChip trust={t} />
          <span className="mono">{pct(mix[t] ?? 0)}</span>
        </span>
      ))}
    </span>
  );
}

export function BeforeAfter({ comparison, leaver, approver }: { comparison: RecoveryComparison; leaver: string; approver: string }) {
  const a = comparison.withLeaver;
  const b = comparison.without;
  const stored = a.source === "stored_run";
  const rows: { label: string; with: React.ReactNode; without: React.ReactNode }[] = [
    { label: "Gaps worked", with: a.summary.worked, without: b.summary.worked },
    { label: "Closed", with: stored ? a.summary.closed : `up to ${a.summary.closed}`, without: b.summary.closed },
    { label: "Partly answered", with: a.summary.partly, without: b.summary.partly },
    { label: "Still open", with: a.summary.open, without: b.summary.open },
    { label: "B", with: a.scores.b, without: b.scores.b },
    { label: "C", with: pct(a.scores.c), without: pct(b.scores.c) },
    { label: "K", with: pct(a.scores.k), without: pct(b.scores.k) },
    { label: "Rests on", with: <Mix mix={a.mix} />, without: <Mix mix={b.mix} /> },
  ];
  return (
    <section className="card mb-5 p-4" aria-label="With and without the leaver">
      <h2 className="text-xl">With {leaver} and without</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-rule text-left">
              <th scope="col" className="py-1.5 pr-3 font-medium text-muted"><span className="sr-only">Measure</span></th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">If {leaver} answered</th>
              <th scope="col" className="py-1.5 font-semibold">Without {leaver}, so far</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-rule align-top last:border-b-0">
                <th scope="row" className="py-1.5 pr-3 text-left font-medium text-ink-2">{r.label}</th>
                <td className="py-1.5 pr-3" data-col="with">{r.with}</td>
                <td className="py-1.5" data-col="without">{r.without}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="align-top text-xs text-muted">
              <td />
              <td className="pt-2 pr-3">
                {stored
                  ? `From a stored run of this demo in which ${leaver} answered every question. Each answer is labelled Leaver said.`
                  : "Worked out by the scoring rules, no model. Each answer would be labelled Leaver said."}
              </td>
              <td className="pt-2">From the latest successor test.</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-3 max-w-4xl text-sm text-ink-2">
        A second-hand answer can close a gap of normal or important weight. It never closes a blocking gap until{" "}
        a record backs it or {approver} confirms it in Review, and it never raises K. A rebuilt procedure only ever
        answers a gap partly. K is the share of what is covered that a record backs, so it falls in both columns:
        neither {leaver}&apos;s word nor a colleague&apos;s is a record. The difference is in what closes.
      </p>
    </section>
  );
}
