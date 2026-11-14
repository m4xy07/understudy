import { Suspense } from "react";
import Link from "next/link";
import { listResponsibilities, peopleNames } from "@/lib/db/queries";
import { roleLabel, roleShort } from "@/lib/pack";
import { loadWorkspace, roleOptions, type WsParams } from "@/lib/page";
import {
  leaverName, listLadder, listQuestions, listTraces, questionsForRole, recoveryComparison, recoveryState, repliesByRole,
  testHistory, toLacunaPack, type QuestionView,
} from "@/lib/lacuna";
import { AnswerBox } from "./AnswerBox";
import { BeforeAfter } from "./BeforeAfter";
import { Ladder } from "./Ladder";
import { NeighbourQuestions } from "./NeighbourQuestions";
import { RebuiltProcedures } from "./RebuiltProcedures";
import { RecoveryBanner, RecoverySwitchCard } from "./RecoverySwitch";
import { checksFor } from "@/lib/lacuna/core/checks";
import { questionText, UNCERTAINTY } from "@/lib/lacuna/core/questions";
import { answerQuestionAction, switchToLeaverAction } from "./actions";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Chip } from "@/components/chips";
import { ScoreLine } from "@/components/Scores";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { EmptyState, Notice } from "@/components/Notice";
import type { Responsibility, RoleKey } from "@/lib/types";

// Server actions of this page re-test with the model (pipeline/guard.ts: ACTION_MAX_DURATION_S).
export const maxDuration = 300;

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
  const { id, role, pack, workspace } = await loadWorkspace(params);
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
  const recovery = await recoveryState(id);
  const leaverPerson = leaverName(pack) || roleShort(leaver, pack);

  if (recovery.on) {
    // Recovery: the leaver cannot be reached. Every read below runs under RLS as the viewing role.
    const [gaps, traces, comparison, mine, replies, names] = await Promise.all([
      listLadder(id, role), listTraces(id, role), recoveryComparison(id), questionsForRole(id, role), repliesByRole(id, role),
      peopleNames(id),
    ]);
    const approverLabel = roleLabel(approver, pack);
    return (
      <>
        <PageHead module="lacuna" step="Step 5" title="Ask only what the record cannot answer">
          Gaps {leaverPerson} would have answered. Each one goes down three rungs: people, files, then possible answers.
          Nothing here counts as much as {leaverPerson}&apos;s own word.
        </PageHead>
        <RecoveryBanner
          ws={id} state={recovery} leaver={leaverPerson} approver={approverLabel}
          isApprover={role === approver} isLeaver={isLeaver}
        />
        <section className="card mb-5 p-4" aria-label="Successor scores">
          <p className="eyebrow">{roleLabel(successor, pack)} now</p>
          <p className="mt-1 text-lg">
            <ScoreLine scores={latest?.scores ?? null} provisional={latest?.provisional ?? true} />
          </p>
        </section>
        {comparison && <BeforeAfter comparison={comparison} leaver={leaverPerson} approver={approverLabel} />}
        <NeighbourQuestions
          ws={id} questions={mine} replies={replies} roles={roleOptions(pack)} leaver={leaverPerson} approver={approverLabel}
        />
        {gaps.length === 0 ? (
          <EmptyState title="No open gaps to work on.">
            Every gap question is answered. {approverLabel} can switch recovery off above.
          </EmptyState>
        ) : (
          <Ladder
            ws={id} gaps={gaps} traces={traces} viewingRole={role} names={names}
            roleLabels={Object.fromEntries(pack.roles.map((r) => [r.key, r.label]))}
          />
        )}
        <RebuiltProcedures ws={id} traces={traces} />
      </>
    );
  }

  // The pack's sample answer is written for the top question of a fresh demo (scripts/precompute.ts).
  const sampleFor = workspace.kind === "demo" && answered.length === 0 && pack.demo?.sampleAnswer ? open[0]?.id : undefined;

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
                Switch to {roleShort(leaver, pack)} to answer
              </SubmitButton>
            </ActionForm>
          </Notice>
        </div>
      )}

      {role === approver && <RecoverySwitchCard ws={id} leaver={leaverPerson} />}

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
                      <AnswerBox sample={q.id === sampleFor ? pack.demo?.sampleAnswer : undefined} />
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
