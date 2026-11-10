import { Suspense } from "react";
import Link from "next/link";
import { getLatestTestRun, listClaims, listSnapshots } from "@/lib/db/queries";
import { roleLabel } from "@/lib/pack";
import { loadWorkspace, type WsParams } from "@/lib/page";
import { listBlockingGaps, planComplete } from "@/lib/lacuna";
import { approveSnapshotAction, bulkApproveAction, reviewAction, savePlanAction } from "@/app/w/actions";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Chip, CoverageChip, StateChip, TierChip, TrustChip } from "@/components/chips";
import { ScoreLine } from "@/components/Scores";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { EmptyState, Notice } from "@/components/Notice";
import type { Claim, RoleKey } from "@/lib/types";

export default function ReviewPage({ params }: { params: WsParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Review params={params} />
    </Suspense>
  );
}

async function Review({ params }: { params: WsParams }) {
  const { id, role, pack, roleName } = await loadWorkspace(params);
  const approverName = roleLabel(pack.approverRole as RoleKey, pack);
  const canApprove = role === pack.approverRole;
  const [claims, gaps, snapshots, run] = await Promise.all([
    listClaims(id, { role }),
    listBlockingGaps(id),
    listSnapshots(id),
    getLatestTestRun(id, pack.successorRole as RoleKey),
  ]);
  const reviewable = claims.filter((c) => c.state !== "dropped");
  const pending = reviewable.filter((c) => c.review === "pending");
  const approved = reviewable.filter((c) => c.review === "approved" || c.review === "edited").length;
  const rejected = reviewable.filter((c) => c.review === "rejected").length;
  const byTier = (t: "A" | "B" | "C") => pending.filter((c) => c.tier === t);
  const unplanned = gaps.filter((g) => !planComplete(g.plan)).length;

  return (
    <>
      <PageHead module="relay" step="Step 6" title="Review and approve">
        The approver ({approverName}) checks claims, plans every open blocking gap, then approves a hashed snapshot.
      </PageHead>

      {!canApprove && (
        <div className="mb-5">
          <Notice tone="warn" title={`Viewing as ${roleName}: read only.`}>
            Only {approverName} can approve.{role === pack.leaverRole ? " The leaver can never approve." : ""} Switch
            &ldquo;Viewing as&rdquo; in the header.
          </Notice>
        </div>
      )}

      <section className="mb-6 grid gap-3 sm:grid-cols-3" aria-label="Review status">
        <div className="card p-4">
          <p className="eyebrow">Pending</p>
          <p className="mt-1 font-serif text-3xl">{pending.length}</p>
          <p className="text-xs text-muted">A {byTier("A").length} · B {byTier("B").length} · C {byTier("C").length}</p>
        </div>
        <div className="card p-4">
          <p className="eyebrow">Approved / rejected</p>
          <p className="mt-1 font-serif text-3xl">
            {approved} <span className="text-lg text-muted">/ {rejected}</span>
          </p>
        </div>
        <div className="card p-4">
          <p className="eyebrow">Successor</p>
          <p className="mt-2">
            <ScoreLine scores={run?.scores ?? null} provisional={false} />
          </p>
        </div>
      </section>

      {reviewable.length === 0 ? (
        <EmptyState title="Nothing to review yet.">
          Run Understudy from <Link className="underline" href={`/w/${id}/connect`}>Connect</Link> first.
        </EmptyState>
      ) : (
        <>
          {canApprove && (
            <section className="card mb-6 flex flex-wrap items-center justify-between gap-3 p-4" aria-label="Bulk approve">
              <p className="max-w-2xl text-sm text-ink-2">
                Approve every pending claim in tiers A and B at once. Tier C (sensitive, conflicting or blocking) still
                needs a written reason, one by one. <em>Walking skeleton: tier B bulk is temporary.</em>
              </p>
              <ActionForm action={bulkApproveAction} hidden={{ ws: id }}>
                <SubmitButton pendingText="Approving…">Approve tiers A and B</SubmitButton>
              </ActionForm>
            </section>
          )}

          <ClaimGroup title="Tier C: needs a written reason" claims={byTier("C")} ws={id} canApprove={canApprove} needReason />
          <ClaimGroup title="Tier B: one by one" claims={byTier("B")} ws={id} canApprove={canApprove} />
          <ClaimGroup title="Tier A: bulk approve" claims={byTier("A")} ws={id} canApprove={canApprove} />
        </>
      )}

      <section className="mt-8" aria-labelledby="plan-h">
        <h2 id="plan-h" className="text-xl">Continuation plan</h2>
        <p className="mt-1 text-sm text-muted">
          Every open blocking gap needs an owner, a due date and the approver&apos;s risk note before release.
        </p>
        {gaps.length === 0 ? (
          <p className="mt-3 text-sm text-ok">
            <span aria-hidden="true">✓ </span>No open blocking gaps.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {gaps.map((g) => (
              <li key={`${g.responsibilityId}|${g.checkKey}`} className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {g.responsibilityTitle}: {g.checkLabel}
                  </p>
                  <span className="flex gap-1.5">
                    <CoverageChip coverage={g.coverage} />
                    {planComplete(g.plan) ? <Chip symbol="✓" label="Planned" tone="ok" /> : <Chip symbol="!" label="Needs plan" tone="warn" />}
                  </span>
                </div>
                {canApprove ? (
                  <ActionForm
                    action={savePlanAction}
                    hidden={{ ws: id, responsibilityId: g.responsibilityId, checkKey: g.checkKey }}
                    className="mt-3 grid gap-2 sm:grid-cols-[1fr_10rem_2fr_auto] sm:items-end"
                  >
                    <label className="grid gap-1 text-sm">
                      <span>Owner</span>
                      <input name="owner" className="field" defaultValue={g.plan?.owner ?? ""} required />
                    </label>
                    <label className="grid gap-1 text-sm">
                      <span>Due date</span>
                      <input name="dueDate" type="date" className="field" defaultValue={g.plan?.dueDate ?? ""} required />
                    </label>
                    <label className="grid gap-1 text-sm">
                      <span>Risk note</span>
                      <input name="riskNote" className="field" defaultValue={g.plan?.riskNote ?? ""} required />
                    </label>
                    <SubmitButton className="btn-quiet" pendingText="Saving…">Save</SubmitButton>
                  </ActionForm>
                ) : (
                  g.plan && (
                    <p className="mt-2 text-sm text-muted">
                      {g.plan.owner} · due {g.plan.dueDate} · {g.plan.riskNote}
                    </p>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card mt-8 p-4 sm:p-5" aria-labelledby="snap-h">
        <h2 id="snap-h" className="text-xl">Approve snapshot</h2>
        <p className="mt-1 text-sm text-muted">
          Hashes the approved claims, their evidence and the continuation plan (SHA-256). B &gt; 0 can only be released once
          every blocking gap is planned{unplanned ? `; ${unplanned} still need a plan` : ""}.
        </p>
        {canApprove ? (
          <ActionForm action={approveSnapshotAction} hidden={{ ws: id }} className="mt-3">
            <SubmitButton pendingText="Hashing…">Approve snapshot</SubmitButton>
          </ActionForm>
        ) : (
          <p className="mt-3 text-sm">Only {approverName} can approve the snapshot.</p>
        )}
        {snapshots.length > 0 && (
          <div className="table-wrap mt-4">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">SHA-256</th>
                  <th scope="col">Claims</th>
                  <th scope="col">Release</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">v{s.version}</td>
                    <td className="mono break-all text-xs">{s.hash}</td>
                    <td className="mono">{s.claimIds.length}</td>
                    <td className="text-sm">
                      {s.openBlocking > 0 ? `Released with ${s.openBlocking} open blocking gaps` : "Released"}
                    </td>
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

function ClaimGroup({
  title, claims, ws, canApprove, needReason,
}: { title: string; claims: Claim[]; ws: string; canApprove: boolean; needReason?: boolean }) {
  if (claims.length === 0) return null;
  return (
    <section className="mb-6" aria-label={title}>
      <h2 className="mb-2 text-lg">
        {title} <span className="text-sm text-muted">({claims.length})</span>
      </h2>
      <ul className="grid gap-2">
        {claims.map((c) => (
          <li key={c.id} className="card p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="max-w-3xl text-sm text-ink">{c.statement}</p>
              <span className="flex flex-wrap gap-1.5">
                <TierChip tier={c.tier} />
                <TrustChip trust={c.trust} />
                <StateChip state={c.state} note={c.stateNote} />
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {c.entityLabel} · {c.attribute}
              {c.citations[0] && (
                <>
                  {" · "}
                  <Link href={`/w/${ws}/source/${c.citations[0].segmentId}?claim=${c.id}`} className="text-attest underline">
                    Open evidence
                  </Link>
                </>
              )}
            </p>
            {canApprove && (
              <ActionForm action={reviewAction} hidden={{ ws, claimId: c.id }} className="mt-2 flex flex-wrap items-end gap-2">
                {needReason && (
                  <label className="grid min-w-[14rem] flex-1 gap-1 text-xs">
                    <span>Reason (required to approve tier C)</span>
                    <input name="note" className="field min-h-9" />
                  </label>
                )}
                <SubmitButton name="decision" value="approved" className="btn-sm">Approve</SubmitButton>
                <SubmitButton name="decision" value="rejected" className="btn-quiet btn-sm">Reject</SubmitButton>
              </ActionForm>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
