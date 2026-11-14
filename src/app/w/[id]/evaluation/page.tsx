import { Suspense } from "react";
import Link from "next/link";
import { listClaims } from "@/lib/db/queries";
import { loadWorkspace, type WsParams } from "@/lib/page";
import { PageHead, PageLoading } from "@/components/PageHead";
import { EmptyState, Notice } from "@/components/Notice";
import { evaluateWorkspace } from "@/lib/attest/evaluation";
import type { Ratio } from "@/lib/attest/core/evaluate";

export default function EvaluationPage({ params }: { params: WsParams }) {
  return (
    <Suspense fallback={<PageLoading label="Scoring against the ground truth…" />}>
      <Evaluation params={params} />
    </Suspense>
  );
}

const pct = (r: Ratio) => (r.value === null ? "n/a" : `${(r.value * 100).toFixed(1)}%`);

function Metric({ label, value, detail, target }: { label: string; value: string; detail?: string; target?: string }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 font-serif text-3xl">{value}</p>
      {detail && <p className="text-xs text-muted">{detail}</p>}
      {target && <p className="text-xs text-ink-2">{target}</p>}
    </div>
  );
}

async function Evaluation({ params }: { params: WsParams }) {
  const { id, workspace, role, roleName } = await loadWorkspace(params);
  const back = (
    <Link href={`/w/${id}/claims`} className="btn btn-quiet btn-sm">
      <span aria-hidden="true">←</span> Back to claims
    </Link>
  );
  if (workspace.kind !== "demo") {
    return (
      <>
        <PageHead module="attest" step="Evaluation" title="Evaluation" aside={back} />
        <Notice title="Evaluation needs the demo data.">
          The answer key only describes the synthetic demo data. Open a demo workspace to see precision and recall.
        </Notice>
      </>
    );
  }

  const [e, visible] = await Promise.all([evaluateWorkspace(id), listClaims(id, { role })]);
  const r = e.report;
  if (r.totals.claims === 0) {
    return (
      <>
        <PageHead module="attest" step="Evaluation" title="Evaluation" aside={back} />
        <EmptyState title="No claims yet.">
          Go to <Link href={`/w/${id}/connect`} className="underline">Connect</Link> and press Run Understudy.
        </EmptyState>
      </>
    );
  }
  // Lists below show only what this role may see: ground-truth items whose role set includes the
  // role, and conflict pairs whose claims are both visible to it. Counts are workspace totals.
  const visibleIds = new Set(visible.map((c) => c.id));
  const gtRoles = new Map(e.groundTruth.claims.map((g) => [g.id, g.roleSet ?? []]));
  const unmatched = r.unmatched.filter((u) => (gtRoles.get(u.id) ?? []).includes(role));
  const hiddenUnmatched = r.unmatched.length - unmatched.length;
  const falsePairs = r.falseConflicts.pairs.filter((p) => p.claimIds.every((cid) => visibleIds.has(cid)));

  return (
    <>
      <PageHead module="attest" step="Evaluation" title="How good are the claims?" aside={back}>
        This demo workspace scored against the planted ground truth ({e.groundTruth.claims.length} facts,{" "}
        {e.groundTruth.supersessions?.length ?? 0} supersessions, {e.groundTruth.conflicts?.length ?? 0} conflicts).
        Lists show what <strong>{roleName}</strong> may see.
      </PageHead>

      {e.modelNote && (
        <div className="mb-4">
          <Notice tone={/unavailable|failed|not read/i.test(e.modelNote) ? "warn" : "info"}>{e.modelNote}</Notice>
        </div>
      )}

      <section aria-label="Headline metrics" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Precision, strict" value={pct(r.precision)} detail={`${r.precision.num} of ${r.precision.den} claims on known entities match a planted fact. A true fact the answer key never planted counts as wrong.`} target="Target 80% or more" />
        <Metric label="Precision on answer-key topics" value={pct(r.topicPrecision)} detail={`${r.topicPrecision.num} of ${r.topicPrecision.den} claims on an entity and attribute the answer key covers match it. A wrong value there still counts as wrong.`} />
        <Metric label="Recall" value={pct(r.recall)} detail={`${r.recall.num} of ${r.recall.den} planted facts found`} target="Target 60% or more" />
        <Metric label="Citation pass rate" value={pct(r.citationPassRate)} detail={`${r.citationPassRate.num} of ${r.citationPassRate.den} citations accepted with an exact quote`} />
        <Metric label="From record share" value={pct(r.fromRecordShare)} detail={`${r.fromRecordShare.num} of ${r.fromRecordShare.den} claims; with corroborated ${pct(r.recordBackedShare)}`} />
      </section>

      <section aria-label="Rule and safety metrics" className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Supersessions found" value={`${r.supersessions.found} / ${r.supersessions.expected}`} detail={r.supersessions.ruleMatched === null ? undefined : `${r.supersessions.ruleMatched} by the planted rule`} />
        <Metric label="False conflicts" value={String(r.falseConflicts.count)} detail={`Planted conflicts found: ${r.plantedConflicts.found} / ${r.plantedConflicts.expected}`} />
        <Metric label="Secrets leaked" value={String(r.secretsLeaked.count)} detail="Must be 0: raw secret values in any claim text" />
        <Metric label="Restricted-token violations" value={String(r.restrictedViolations.count)} detail="Must be 0: canary claims visible beyond their roles" />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4" aria-label="Recall per entity">
          <h2 className="text-lg">Recall per entity</h2>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 font-medium">Entity</th>
                <th className="py-1 text-right font-medium">Found</th>
                <th className="py-1 text-right font-medium">Recall</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(r.perEntity)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([entity, pe]) => (
                  <tr key={entity} className="border-t border-rule">
                    <td className="mono py-1">{entity}</td>
                    <td className="mono py-1 text-right">
                      {pe.matched}/{pe.expected}
                    </td>
                    <td className="mono py-1 text-right">{pe.recall === null ? "n/a" : `${Math.round(pe.recall * 100)}%`}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>

        <section className="card p-4" aria-label="Unmatched items">
          <h2 className="text-lg">Planted facts not found</h2>
          {unmatched.length === 0 && hiddenUnmatched === 0 ? (
            <p className="mt-2 text-sm text-muted">Every planted fact was found.</p>
          ) : (
            <ul className="mt-2 grid gap-1 text-sm">
              {unmatched.map((u) => (
                <li key={u.id}>
                  <span className="mono text-xs text-muted">{u.id}</span> {u.entity} · <span className="mono">{u.attribute}</span>: {u.value}
                </li>
              ))}
              {hiddenUnmatched > 0 && <li className="text-muted">{hiddenUnmatched} more outside what {roleName} may see.</li>}
            </ul>
          )}
          {r.supersessions.missing.length > 0 && (
            <>
              <h3 className="mt-4 font-medium">Supersessions not found</h3>
              <ul className="mt-1 grid gap-1 text-sm">
                {r.supersessions.missing.map((s) => (
                  <li key={`${s.entity}-${s.attribute}-${s.old}`}>
                    {s.entity} · <span className="mono">{s.attribute}</span>
                    {s.attribute === "contact" ? " (multi-valued: both contacts stay; the newest is current)" : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          {falsePairs.length > 0 && (
            <>
              <h3 className="mt-4 font-medium">False conflicts</h3>
              <ul className="mt-1 grid gap-1 text-sm">
                {falsePairs.map((p) => (
                  <li key={p.claimIds.join("-")}>
                    <a className="text-attest underline" href={`/w/${id}/claims#${p.claimIds[0]}`}>
                      {p.entity} · {p.attribute}
                    </a>
                    : “{p.values[0]}” vs “{p.values[1]}”
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <p className="mt-4 text-xs text-muted">
        Totals: {r.totals.claims} claims ({r.totals.active} active, {r.totals.superseded} superseded, {r.totals.conflicting} conflicting),{" "}
        {r.totals.droppedDrafts} drafts dropped. Role set correct on {pct(r.roleSetCorrect)} of matched facts; source correct on{" "}
        {pct(r.sourceCorrect)}.
        {e.extractMs !== null && ` Extraction took ${(e.extractMs / 1000).toFixed(1)} s (${e.cachedBatches} of ${e.batches} batches from the cache).`}
      </p>
    </>
  );
}
