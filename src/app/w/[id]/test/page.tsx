import { Suspense } from "react";
import Link from "next/link";
import { getLatestTestRun, listResponsibilities } from "@/lib/db/queries";
import { isRoleOf, roleLabel, roleShort } from "@/lib/pack";
import { first, loadWorkspace, type SearchParams, type WsParams } from "@/lib/page";
import { citedSegments, listBlockingGaps, testHistory, toLacunaPack } from "@/lib/lacuna";
import { checksFor } from "@/lib/lacuna/core/checks";
import { confirmInventoryAction, rerunTestAction } from "./actions";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Chip, CoverageChip } from "@/components/chips";
import { ScoreLegend, ScoreLine, scoresText } from "@/components/Scores";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { EmptyState, Notice } from "@/components/Notice";
import type { CheckResult, Coverage, Responsibility, RoleKey } from "@/lib/types";

// Server actions of this page re-test with the model (pipeline/guard.ts: ACTION_MAX_DURATION_S).
export const maxDuration = 300;

const KIND_LABEL: Record<Responsibility["kind"], string> = {
  deploy_operate: "Deploy / operate",
  external_relationship: "External relationship",
  recurring_obligation: "Recurring obligation",
  open_decision: "Open decision",
  unfinished_work: "Unfinished work",
};

const GENERIC_NOTE: Record<Coverage, string> = {
  covered: "",
  partial: "Only part of this is on record.",
  missing: "Nothing on record for this.",
  restricted: "Evidence exists for other roles.",
  conflicting: "The record disagrees with itself.",
};

/** Every origin the inventory found, from the origin detail ("Task board: card T-031 · Footprint: repeat"). */
function originBadges(r: Responsibility): { symbol: string; label: string }[] {
  const out: { symbol: string; label: string }[] = [];
  for (const part of r.originDetail.split(" · ")) {
    const [head, ...rest] = part.split(": ");
    const detail = rest.join(": ").trim();
    if (head === "Task board") out.push({ symbol: "▦", label: `Task board${detail ? `: ${detail}` : ""}` });
    else if (head === "Footprint") out.push({ symbol: "⌖", label: `Footprint: ${detail || "rule"}` });
    else if (head === "Role template") out.push({ symbol: "▤", label: "Role template" });
  }
  const seen = new Set<string>();
  return out.filter((b) => (seen.has(b.label) ? false : (seen.add(b.label), true)));
}

export default function TestPage({ params, searchParams }: { params: WsParams; searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Test params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Test({ params, searchParams }: { params: WsParams; searchParams: SearchParams }) {
  const { id, pack, role } = await loadWorkspace(params);
  const lpack = toLacunaPack(pack);
  const sp = await searchParams;
  const asked = first(sp.target);
  const successor = pack.successorRole as RoleKey;
  const approver = pack.approverRole as RoleKey;
  const target: RoleKey = isRoleOf(pack, asked) ? asked : successor;
  // The successor, then every role the pack flags as restricted audience.
  const targets: RoleKey[] = pack.testRoles;
  const [run, responsibilities, history, gaps] = await Promise.all([
    getLatestTestRun(id, target),
    listResponsibilities(id),
    testHistory(id, target, 12),
    listBlockingGaps(id, target),
  ]);
  const results = new Map((run?.results ?? []).map((r) => [`${r.responsibilityId}|${r.checkKey}`, r]));
  // Stand-in notes can quote what the tested role sees: only that role and the approver read them.
  const showNotes = role === target || role === approver;
  const shownIds = [...new Set((run?.results ?? []).flatMap((r) => r.claimIds))];
  const segFor = shownIds.length ? await citedSegments(id, role, shownIds) : {};
  const confirmed = responsibilities.length > 0 && responsibilities.every((r) => r.confirmed);
  const latest = history[history.length - 1];

  return (
    <>
      <PageHead
        module="lacuna"
        step="Step 4"
        title="Could the successor do this tomorrow?"
        aside={
          <ActionForm action={rerunTestAction} hidden={{ ws: id, target }}>
            <SubmitButton className="btn-quiet" pendingText="Testing…">Re-run test</SubmitButton>
          </ActionForm>
        }
      >
        A stand-in for the role works through each responsibility using only the claims that role may see, and says
        for every check what it can cite or what stops it.
      </PageHead>

      <nav aria-label="Role being tested" className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Testing as:</span>
        {targets.map((t) => (
          <Link
            key={t}
            href={`/w/${id}/test?target=${t}`}
            aria-current={t === target ? "page" : undefined}
            className={t === target ? "btn btn-sm" : "btn btn-quiet btn-sm"}
          >
            {roleLabel(t, pack)}
            {t === successor ? " (successor)" : ""}
          </Link>
        ))}
      </nav>

      <section className="card mb-6 p-4 sm:p-5" aria-label="Scores">
        <p className="eyebrow">Scores for {roleLabel(target, pack)}</p>
        <p className="mt-2 text-xl">
          <ScoreLine scores={run?.scores ?? null} provisional={run?.provisional ?? true} />
        </p>
        <div className="mt-2">
          <ScoreLegend />
        </div>
        {run && (
          <p className="mt-2 text-xs text-muted">
            {run.provisional ? "Provisional until review: the approver has not signed a snapshot of this state. " : ""}
            {run.modelUsed ? "Judged by the stand-in model, checked against the record by code." : "Judged by the deterministic reading of the record (model not used)."}
            {latest?.modelNote ? ` ${latest.modelNote}` : ""}
          </p>
        )}
      </section>

      {gaps.length > 0 && (
        <section className="mb-6" aria-label="Blocking gaps">
          <h2 className="mb-2 text-xl">Blocking gaps (B {run?.scores.b ?? gaps.length})</h2>
          <ul className="grid gap-1.5">
            {gaps.map((g) => (
              <li key={`${g.responsibilityId}|${g.checkKey}`} className="flex flex-wrap items-center gap-2 rounded border border-rule bg-card px-3 py-2 text-sm">
                <CoverageChip coverage={g.coverage} />
                <span className="mono text-muted">{g.responsibilityKey}</span>
                <span className="font-medium">{g.responsibilityTitle}</span>
                <span>· {g.checkLabel}</span>
                {g.plan?.owner ? (
                  <Chip symbol="☑" label={`Plan: ${g.plan.owner}${g.plan.dueDate ? `, by ${g.plan.dueDate}` : ""}`} tone="info" />
                ) : (
                  <Chip symbol="!" label="No continuation plan yet" tone="warn" />
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">
            The approver ({roleLabel(approver, pack)}) sets an owner, a due date and a risk note for each on the Review page.
          </p>
        </section>
      )}

      <section className="mb-6" aria-labelledby="inv-h">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <h2 id="inv-h" className="text-xl">Responsibility inventory ({responsibilities.length})</h2>
          {responsibilities.length > 0 && (
            confirmed ? (
              <Chip symbol="✓" label={`Confirmed by ${roleLabel(approver, pack)}`} tone="ok" />
            ) : role === approver ? (
              <ActionForm action={confirmInventoryAction} hidden={{ ws: id }}>
                <SubmitButton className="btn-sm" pendingText="Confirming…">Confirm inventory</SubmitButton>
              </ActionForm>
            ) : (
              <Chip symbol="◷" label={`Waiting for ${roleLabel(approver, pack)} to confirm`} tone="hold" />
            )
          )}
        </div>
        <p className="mb-3 text-sm text-muted">
          Found from the task board, the leaver&rsquo;s footprint (what {roleShort(pack.leaverRole, pack)} actually did, off the board) and the role
          template, merged by topic.
        </p>

        {responsibilities.length === 0 ? (
          <EmptyState title="No responsibilities yet.">
            Run Understudy from <Link href={`/w/${id}/connect`} className="underline">Connect</Link> to build the inventory.
          </EmptyState>
        ) : (
          <ul className="grid gap-3">
            {responsibilities.map((r) => (
              <li key={r.id} className="card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-lg">
                    <span className="mono mr-2 text-sm text-muted">{r.key}</span>
                    {r.title}
                  </h3>
                  <span className="flex flex-wrap gap-1.5">
                    {originBadges(r).map((b) => <Chip key={b.label} symbol={b.symbol} label={b.label} />)}
                    <Chip symbol="◇" label={KIND_LABEL[r.kind]} />
                    {r.dueDate && <Chip symbol="◷" label={`Due ${r.dueDate}`} />}
                  </span>
                </div>
                <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                  {checksFor(r, lpack).map((check) => {
                    const res: CheckResult | undefined = results.get(`${r.id}|${check.key}`);
                    const note = res ? (showNotes ? res.note : GENERIC_NOTE[res.coverage]) : "";
                    return (
                      <li key={check.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-rule px-2.5 py-1.5 text-sm">
                        {res ? <CoverageChip coverage={res.coverage} /> : <Chip symbol="·" label="Not tested" />}
                        <span className="font-medium">{check.label}</span>
                        <span className="text-xs text-muted">
                          {check.wTag} · {check.weight === 5 ? "blocking" : check.weight === 3 ? "important" : "normal"}
                        </span>
                        {res && res.claimIds.length > 0 && res.coverage !== "missing" && (
                          <span className="basis-full text-xs">
                            <span className="text-muted">Evidence: </span>
                            {res.claimIds.slice(0, 4).map((cid, i) => (
                              <span key={cid}>
                                {i > 0 && ", "}
                                {segFor[cid] ? (
                                  <Link href={`/w/${id}/source/${segFor[cid]}?claim=${cid}`} className="mono text-attest underline">
                                    {cid}
                                  </Link>
                                ) : (
                                  <span className="mono text-muted" title="Not visible to your role">{cid}</span>
                                )}
                              </span>
                            ))}
                            {res.claimIds.length > 4 ? ` +${res.claimIds.length - 4}` : ""}
                          </span>
                        )}
                        {res && res.coverage !== "covered" && note && (
                          <span className="basis-full text-xs text-muted">
                            {check.weight === 5 ? <strong className="text-ink-2">Blocker: </strong> : null}
                            {note}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="hist-h" className="mb-6">
        <h2 id="hist-h" className="mb-2 text-xl">Score over time ({roleLabel(target, pack)})</h2>
        {history.length === 0 ? (
          <Notice tone="info">No test has run for this role yet. Use &ldquo;Re-run test&rdquo;.</Notice>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Test runs, oldest first</caption>
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">When</th>
                  <th scope="col" className="px-3 py-2 font-medium">Scores (B, C, K)</th>
                  <th scope="col" className="px-3 py-2 font-medium">Why it ran</th>
                  <th scope="col" className="px-3 py-2 font-medium">Stand-in</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={h.id} className="border-t border-rule" aria-current={i === history.length - 1 ? "true" : undefined}>
                    <td className="mono px-3 py-1.5 text-xs">{h.createdAt.replace("T", " ").slice(0, 19)}</td>
                    <td className="mono px-3 py-1.5">
                      {scoresText(h.scores)}
                      {i > 0 && history[i - 1].scores.b !== h.scores.b && (
                        <span className="ml-2 text-xs text-muted">(B {history[i - 1].scores.b} → {h.scores.b})</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-muted">{h.trigger.replace(/^answer gq_\w+/, "after an answer")}</td>
                    <td className="px-3 py-1.5 text-xs text-muted">{h.modelUsed ? "model + code" : "code only"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
