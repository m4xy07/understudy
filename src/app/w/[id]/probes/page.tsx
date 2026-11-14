import { Suspense } from "react";
import Link from "next/link";
import { loadWorkspace, type WsParams } from "@/lib/page";
import { roleLabel } from "@/lib/pack";
import { runLeakCheck } from "@/lib/relay";
import { demoProbeFacts } from "@/lib/relay/handover";
import { loadProbeSummary, pct } from "@/lib/relay/probe-summary";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Notice } from "@/components/Notice";
import type { RoleKey } from "@/lib/types";
import { LeakGridView, when } from "../handover/LeakGrid";

// "Run probes again" asks the model judge inside a time box of 40 seconds.
export const maxDuration = 60;

const CATEGORY_LABEL: Record<string, string> = { finance: "Money", hr: "People matter", health: "Health" };

export default function ProbesPage({ params }: { params: WsParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Probes params={params} />
    </Suspense>
  );
}

async function Probes({ params }: { params: WsParams }) {
  const { id, role, pack, workspace } = await loadWorkspace(params);
  const isApprover = role === pack.approverRole;
  const approverLabel = roleLabel(pack.approverRole, pack);
  const summary = loadProbeSummary(pack);
  const report = await runLeakCheck(id);
  const facts = new Map(demoProbeFacts(pack).map((f) => [f.id, f]));
  const surfaceLabel = new Map(report.surfaces.map((s) => [s.key, s.label]));
  const c = summary?.classifier;
  const d = summary?.detector;
  const missedClassifier = c?.missed ?? [];
  const missedDetector = d?.missed ?? [];

  return (
    <>
      <PageHead
        module="relay"
        step="Leak check"
        title="Probe results"
        aside={<Link href={`/w/${id}/handover`} className="btn btn-quiet btn-sm"><span aria-hidden="true">←</span> Back to handover</Link>}
      >
        Restricted facts were planted in reworded form. This page shows what each check caught and what it missed.
      </PageHead>

      {/* 1. Classifier */}
      <section className="card p-4 sm:p-5" aria-labelledby="cls-h">
        <h2 id="cls-h" className="text-xl">Classifier</h2>
        {!c ? (
          <p className="mt-2 text-sm text-muted">
            The classifier has not been measured for this setting yet. The numbers come from a labelled evaluation set
            that is scored outside your workspace.
          </p>
        ) : (
          <>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Measured on a labelled evaluation set of {c.segments} messages ({c.positives} sensitive, {c.negatives} routine),
              scored in a scratch workspace on {when(summary.generatedAt)}. The set is not part of
              {workspace.kind === "demo" ? " this demo's sources." : " your sources."}
            </p>
            <div className="table-wrap mt-3">
              <table className="data-table" data-testid="classifier-table">
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col" className="text-right">Planted</th>
                    <th scope="col" className="text-right">Caught by a rule</th>
                    <th scope="col" className="text-right">Caught by the model</th>
                    <th scope="col" className="text-right">Held</th>
                    <th scope="col" className="text-right">Missed</th>
                    <th scope="col" className="text-right">Wrongly limited</th>
                  </tr>
                </thead>
                <tbody>
                  {c.rows.map((r) => (
                    <tr key={r.category}>
                      <th scope="row" className="text-left text-sm font-medium normal-case tracking-normal text-ink">{CATEGORY_LABEL[r.category] ?? r.category}</th>
                      <td className="mono text-right">{r.planted}</td>
                      <td className="mono text-right">{r.byRule}</td>
                      <td className="mono text-right">{r.byModel}</td>
                      <td className="mono text-right">{r.held}</td>
                      <td className="mono text-right">{r.missed}</td>
                      <td className="mono text-right">{r.wronglyLimited}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm">
              Precision {pct(c.precision)}. Recall {pct(c.recall)}. {c.segments} messages checked.
            </p>
            <p className="mt-1 text-sm text-muted">
              With the model switched off the rules alone reach recall {pct(c.recallRulesOnly)}, and {c.heldModelOff}{" "}
              borderline {c.heldModelOff === 1 ? "message is" : "messages are"} held for the approver instead of being released.
              The {c.primaryCases.of} planted cases in the open group chat: {c.primaryCases.caught} of {c.primaryCases.of} caught by a rule alone.
            </p>
          </>
        )}
      </section>

      {/* 2. Outputs */}
      <LeakGridView r={report} ws={id} isApprover={isApprover} showResultsLink={false} />

      {/* 3. Detector check */}
      <section className="card mt-8 p-4 sm:p-5" aria-labelledby="det-h">
        <h2 id="det-h" className="text-xl">Detector check</h2>
        {!d ? (
          <p className="mt-2 text-sm text-muted">The checks themselves have not been measured for this setting yet.</p>
        ) : (
          <>
            <p className="mt-2 max-w-3xl text-sm" data-testid="detector-line">
              We fed {d.rewordings} reworded leaks straight into each check to see what it catches. Key terms caught {d.keyTerms}.
              {" "}{d.judgeAsked ? `The model judge caught ${d.judgeOnly} more.` : "The model judge was not asked in this run."}
              {" "}{d.neither} got past both.
            </p>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              {d.catchable.total} of these use at least some of a fact&apos;s key terms: key terms caught {d.catchable.keyTerms} of them.
              The other {d.hard.total} avoid every key term on purpose: key terms caught {d.hard.keyTerms}, the model judge
              caught {d.hard.judgeOnly}, and {d.hard.neither} got past both.
            </p>
          </>
        )}
      </section>

      {/* 4. Findings */}
      <section className="card mt-8 p-4 sm:p-5" aria-labelledby="find-h">
        <h2 id="find-h" className="text-xl">Findings</h2>
        <p className="mt-1 text-sm text-muted">What the checks found in this workspace&apos;s outputs right now.</p>
        {report.findings.length === 0 ? (
          <p className="mt-3 text-sm"><span aria-hidden="true" className="text-ok">✓ </span>No check found a restricted token or fact in any role&apos;s outputs.</p>
        ) : (
          <ul className="mt-3 grid gap-2 text-sm">
            {report.findings.map((f, i) => (
              <li key={i} className="rounded-md border border-rule p-2">
                <span className={f.confirmed ? "font-semibold text-bad" : "text-ink-2"}>
                  <span aria-hidden="true">{f.confirmed ? "✕ " : "? "}</span>
                  {f.row === "token" ? `Token ${isApprover ? f.item : "(hidden)"}` : `Probe ${f.item}`} · {roleLabel(f.role as RoleKey, pack)} ·{" "}
                  {surfaceLabel.get(f.surface) ?? f.surface} · caught by {f.by === "judge" ? "model judge" : f.by === "token" ? "exact token" : "key terms"}
                  {!f.confirmed && " (unconfirmed: the quoted words are not in the text)"}
                </span>
                {isApprover && f.row === "probe" && (
                  <span className="mt-1 block text-ink-2">
                    Fact: {facts.get(f.item)?.fact ?? f.item}
                    <span className="block text-muted">Matching words: {f.quote.slice(0, 300)}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {!isApprover && report.findings.length > 0 && (
          <p className="mt-2 text-xs text-muted">The fact text and the matching words are shown to the approver ({approverLabel}) only.</p>
        )}
      </section>

      {/* 5. Missed */}
      <section className="card mt-8 p-4 sm:p-5" aria-labelledby="miss-h">
        <h2 id="miss-h" className="text-xl">Missed</h2>
        {!summary ? (
          <p className="mt-2 text-sm text-muted">Nothing has been measured for this setting yet.</p>
        ) : missedClassifier.length + missedDetector.length === 0 ? (
          <p className="mt-2 text-sm">Nothing was missed in this run.</p>
        ) : (
          <>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Planted items that no check caught in the evaluation. These are honest misses: wording with no word the
              rules know, which the model stage never sees or does not flag.
            </p>
            <ul className="mt-3 grid gap-1.5 text-sm">
              {missedClassifier.map((m) => (
                <li key={m.id}>
                  <span className="mono text-muted">{m.id}</span> Classifier · {CATEGORY_LABEL[m.category] ?? m.category} · {m.difficulty === "hard" ? "no known word" : m.difficulty === "model" ? "weak words only" : "rule wording"}
                  {isApprover && <span className="block text-ink-2">Wording that got through: {m.text}</span>}
                </li>
              ))}
              {missedDetector.map((m, i) => (
                <li key={`d${i}`}>
                  <span className="mono text-muted">{m.factId}</span> Detector check · {m.kind === "hard" ? "avoids every key term" : "reworded"}
                  {isApprover && <span className="block text-ink-2">Wording that got through: {m.text}</span>}
                </li>
              ))}
            </ul>
            {!isApprover && <p className="mt-2 text-xs text-muted">The wording is shown to the approver ({approverLabel}) only.</p>}
          </>
        )}
      </section>

      {/* 6. What we do about a miss */}
      <section className="mt-8">
        <Notice tone="info" title="What we do about a miss">
          A miss is fixed by the approver with &ldquo;Limit who sees this&rdquo; on the message. The change applies at
          once to claims and handovers, and is logged.
        </Notice>
      </section>
    </>
  );
}
