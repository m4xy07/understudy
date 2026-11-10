import { Suspense } from "react";
import Link from "next/link";
import { listResponsibilities } from "@/lib/db/queries";
import { roleLabel } from "@/lib/pack";
import { loadWorkspace, roleOptions, type WsParams } from "@/lib/page";
import { listQuestions, testHistory, toLacunaPack, type QuestionView } from "@/lib/lacuna";
import { checksFor } from "@/lib/lacuna/core/checks";
import { questionText, UNCERTAINTY } from "@/lib/lacuna/core/questions";
import { answerQuestionAction, switchToLeaverAction } from "./actions";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Chip } from "@/components/chips";
import { ScoreLine } from "@/components/Scores";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { EmptyState, Notice } from "@/components/Notice";
import type { Responsibility, RoleKey } from "@/lib/types";

const GAP = {
  missing: { symbol: "○", label: "Missing", tone: "bad" as const },
  partial: { symbol: "◐", label: "Partial", tone: "warn" as const },
  conflicting: { symbol: "⇄", label: "Conflicting", tone: "bad" as const },
};

function importance(w: number | null): string {
  return w === 5 ? "blocking" : w === 3 ? "important" : "normal";
}

/** "blocking check (weight 5) × missing (1.0) × due within 14 days (1.5) = 7.5" */
function whyAsked(q: QuestionView): string {
  const w = q.weight ?? 0;
  const parts = [`${importance(w)} check (weight ${w})`, `${q.gapType} (${UNCERTAINTY[q.gapType].toFixed(1)})`];
  parts.push(q.urgency && q.urgency > 1 ? `due within 14 days (${q.urgency})` : "not due soon (1)");
  return `${parts.join(" × ")} = ${Number(q.score.toFixed(2))}`;
}

export default function AskPage({ params }: { params: WsParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Ask params={params} />
    </Suspense>
  );
}

async function Ask({ params }: { params: WsParams }) {
  const { id, role, pack } = await loadWorkspace(params);
  const lpack = toLacunaPack(pack);
  const successor = pack.successorRole as RoleKey;
  const leaver = pack.leaverRole as RoleKey;
  const approver = pack.approverRole as RoleKey;
  const [questions, responsibilities, history] = await Promise.all([
    listQuestions(id),
    listResponsibilities(id),
    testHistory(id, successor, 2),
  ]);
  const byId = new Map(responsibilities.map((r) => [r.id, r]));
  const isLeaver = role === leaver;
  // Conflicting questions quote values the successor and the leaver may see; other roles get the
  // question without the values.
  const fullText = role === leaver || role === approver || role === successor;
  const open = questions.filter((q) => !q.answeredClaimId);
  const answered = questions.filter((q) => q.answeredClaimId);
  const latest = history[history.length - 1];
  const base = pack.uploadDefaults.roleSet as RoleKey[];
  const always = new Set<RoleKey>([leaver, approver]);

  const textFor = (q: QuestionView, r: Responsibility | undefined): string => {
    if (fullText || q.gapType !== "conflicting" || !r) return q.text;
    const check = checksFor(r, lpack).find((c) => c.key === q.checkKey);
    return check ? questionText({ gapType: "conflicting", claimIds: [] }, r, check, r.kind, [], leaver) : q.text;
  };

  return (
    <>
      <PageHead module="lacuna" step="Step 5" title="Ask only what the record cannot answer">
        Up to ten questions for {roleLabel(leaver, pack)}, ranked by weight × uncertainty × urgency. Answers come back
        labelled &ldquo;Leaver said&rdquo;: they raise C, not K, until a record backs them.
      </PageHead>

      <section className="card mb-5 p-4" aria-label="Successor scores">
        <p className="eyebrow">{roleLabel(successor, pack)} now</p>
        <p className="mt-1 text-lg">
          <ScoreLine scores={latest?.scores ?? null} provisional={latest?.provisional ?? true} />
        </p>
        {answered[0]?.scoreDelta && (
          <p className="mt-1 text-sm text-ink-2">
            <span className="text-muted">Last answer: </span>
            <span className="mono">{answered[0].scoreDelta}</span>
          </p>
        )}
      </section>

      {!isLeaver && (
        <div className="mb-5">
          <Notice tone="info" title={`Only ${roleLabel(leaver, pack)} answers these.`}>
            <ActionForm action={switchToLeaverAction} hidden={{ ws: id }} className="mt-1">
              <SubmitButton className="btn-sm" pendingText="Switching…">
                Switch to {roleLabel(leaver, pack).split(/[\s(]/)[0]} to answer
              </SubmitButton>
            </ActionForm>
          </Notice>
        </div>
      )}

      {questions.length === 0 ? (
        <EmptyState title="No gap questions yet.">
          They appear after the successor test. Run Understudy from{" "}
          <Link href={`/w/${id}/connect`} className="underline">Connect</Link>, or re-run the test on{" "}
          <Link href={`/w/${id}/test`} className="underline">Test</Link>.
        </EmptyState>
      ) : (
        <>
          <h2 className="mb-2 text-xl">Open questions ({open.length})</h2>
          {open.length === 0 && <Notice tone="info">Every question is answered. Re-run the test to look for new gaps.</Notice>}
          <ol className="grid gap-3">
            {open.map((q) => {
              const r = byId.get(q.responsibilityId);
              return (
                <li key={q.id} className="card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="max-w-3xl text-ink">
                      <span className="mono mr-2 text-muted">{q.rank}.</span>
                      {textFor(q, r)}
                    </p>
                    <span className="flex flex-wrap gap-1.5">
                      <Chip {...GAP[q.gapType]} />
                      {q.weight === 5 && <Chip symbol="■" label="Blocking" tone="bad" />}
                      {q.urgency !== null && q.urgency > 1 && <Chip symbol="◷" label="Due soon" tone="warn" />}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {r ? <><span className="mono">{r.key}</span> {r.title} · </> : null}
                    Why asked: {whyAsked(q)}
                  </p>
                  {isLeaver && (
                    <ActionForm action={answerQuestionAction} hidden={{ ws: id, questionId: q.id }} className="mt-3 grid gap-2">
                      <label className="grid gap-1 text-sm">
                        <span className="font-medium">Your answer</span>
                        <textarea name="answer" required minLength={2} maxLength={4000} rows={3} className="field" />
                      </label>
                      <fieldset className="text-sm">
                        <legend className="text-muted">Narrow who can see this answer (untick to hide it from a role)</legend>
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                          {roleOptions(pack).filter((o) => base.includes(o.key)).map((o) =>
                            always.has(o.key) ? (
                              <label key={o.key} className="inline-flex items-center gap-1.5 text-muted">
                                <input type="hidden" name="roles" value={o.key} />
                                <input type="checkbox" checked disabled className="h-4 w-4" aria-describedby={`always-${q.id}`} />
                                {o.label}
                              </label>
                            ) : (
                              <label key={o.key} className="inline-flex items-center gap-1.5">
                                <input type="checkbox" name="roles" value={o.key} defaultChecked className="h-4 w-4" />
                                {o.label}
                              </label>
                            ),
                          )}
                        </div>
                        <p id={`always-${q.id}`} className="mt-1 text-xs text-muted">
                          You and {roleLabel(approver, pack)} always keep it. An answer can be narrowed, never widened.
                        </p>
                      </fieldset>
                      <div>
                        <SubmitButton pendingText="Saving and re-testing…">Save answer</SubmitButton>
                      </div>
                    </ActionForm>
                  )}
                </li>
              );
            })}
          </ol>
          {answered.length > 0 && (
            <>
              <h2 className="mt-8 mb-2 text-xl">Answered ({answered.length})</h2>
              <ul className="grid gap-2">
                {answered.map((q) => {
                  const r = byId.get(q.responsibilityId);
                  return (
                    <li key={q.id} className="card grid gap-1 p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="max-w-3xl">{textFor(q, r)}</span>
                        <span className="flex items-center gap-2">
                          <Chip symbol="❝" label="Leaver said" tone="info" />
                          <Link href={`/w/${id}/claims?trust=leaver_said`} className="text-attest underline">
                            See claim
                          </Link>
                        </span>
                      </div>
                      {q.scoreDelta && (
                        <p className="text-xs text-muted">
                          Re-test after this answer: <span className="mono text-ink-2">{q.scoreDelta}</span>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}
