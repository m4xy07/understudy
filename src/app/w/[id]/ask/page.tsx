import { Suspense } from "react";
import Link from "next/link";
import { getTestRunHistory, listGapQuestions, listResponsibilities } from "@/lib/db/queries";
import { roleLabel } from "@/lib/pack";
import { loadWorkspace, roleOptions, type WsParams } from "@/lib/page";
import { answerAction } from "@/app/w/actions";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Chip } from "@/components/chips";
import { ScoreLine, scoresText } from "@/components/Scores";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { EmptyState, Notice } from "@/components/Notice";
import type { RoleKey } from "@/lib/types";

const GAP = {
  missing: { symbol: "○", label: "Missing", tone: "bad" as const },
  partial: { symbol: "◐", label: "Partial", tone: "warn" as const },
  conflicting: { symbol: "⇄", label: "Conflicting", tone: "bad" as const },
};

export default function AskPage({ params }: { params: WsParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Ask params={params} />
    </Suspense>
  );
}

async function Ask({ params }: { params: WsParams }) {
  const { id, role, pack } = await loadWorkspace(params);
  const successor = pack.successorRole as RoleKey;
  const [questions, responsibilities, history] = await Promise.all([
    listGapQuestions(id),
    listResponsibilities(id),
    getTestRunHistory(id, successor, 2),
  ]);
  const titles = new Map(responsibilities.map((r) => [r.id, r.title]));
  const isLeaver = role === pack.leaverRole;
  const open = questions.filter((q) => !q.answeredClaimId);
  const answered = questions.filter((q) => q.answeredClaimId);
  const [latest, previous] = history;

  return (
    <>
      <PageHead module="lacuna" step="Step 5" title="Ask only what the record cannot answer">
        Ranked by weight × uncertainty × urgency. Answers come back labelled &ldquo;Leaver said&rdquo; and raise C, not K,
        until a record backs them.
      </PageHead>

      <section className="card mb-5 p-4" aria-label="Successor scores">
        <p className="eyebrow">{roleLabel(successor, pack)} now</p>
        <p className="mt-1 text-lg">
          <ScoreLine scores={latest?.scores ?? null} provisional={latest?.provisional ?? true} />
        </p>
        {previous && latest && (
          <p className="mt-1 text-sm text-muted">
            Before the last change: <span className="mono">{scoresText(previous.scores)}</span>
          </p>
        )}
      </section>

      {!isLeaver && (
        <div className="mb-5">
          <Notice tone="info" title={`Only ${roleLabel(pack.leaverRole as RoleKey, pack)} answers these.`}>
            Switch &ldquo;Viewing as&rdquo; in the header to {roleLabel(pack.leaverRole as RoleKey, pack)} to answer.
          </Notice>
        </div>
      )}

      {questions.length === 0 ? (
        <EmptyState title="No gap questions yet.">
          They appear after the successor test. Run Understudy from{" "}
          <Link href={`/w/${id}/connect`} className="underline">Connect</Link>.
        </EmptyState>
      ) : (
        <>
          <h2 className="mb-2 text-xl">Open questions ({open.length})</h2>
          <ol className="grid gap-3">
            {open.map((q) => (
              <li key={q.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="max-w-3xl text-ink">
                    <span className="mono mr-2 text-muted">{q.rank}.</span>
                    {q.text}
                  </p>
                  <span className="flex gap-1.5">
                    <Chip {...GAP[q.gapType]} />
                    <Chip symbol="≡" label={`score ${q.score.toFixed(1)}`} />
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">{titles.get(q.responsibilityId) ?? q.responsibilityId}</p>
                {isLeaver && (
                  <ActionForm action={answerAction} hidden={{ ws: id, questionId: q.id }} className="mt-3 grid gap-2">
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">Your answer</span>
                      <textarea name="answer" required rows={3} className="field" />
                    </label>
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted">Narrow who can see this answer (optional)</summary>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                        {roleOptions(pack).map((r) => (
                          <label key={r.key} className="inline-flex items-center gap-1.5">
                            <input type="checkbox" name="roles" value={r.key} className="h-4 w-4" />
                            {r.label}
                          </label>
                        ))}
                      </div>
                    </details>
                    <div>
                      <SubmitButton pendingText="Saving and re-testing…">Save answer</SubmitButton>
                    </div>
                  </ActionForm>
                )}
              </li>
            ))}
          </ol>
          {answered.length > 0 && (
            <>
              <h2 className="mt-8 mb-2 text-xl">Answered ({answered.length})</h2>
              <ul className="grid gap-2">
                {answered.map((q) => (
                  <li key={q.id} className="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                    <span className="max-w-3xl">{q.text}</span>
                    <span className="flex items-center gap-2">
                      <Chip symbol="❝" label="Leaver said" tone="info" />
                      <Link href={`/w/${id}/claims?trust=leaver_said`} className="text-attest underline">
                        See claim
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}
