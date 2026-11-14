import { Suspense } from "react";
import Link from "next/link";
import { roleLabel } from "@/lib/pack";
import { loadWorkspace, type WsParams } from "@/lib/page";
import { firstWeeks, listFindings, type FindingView } from "@/lib/relay/living";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Chip } from "@/components/chips";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { EmptyState, Notice } from "@/components/Notice";
import type { RoleKey } from "@/lib/types";
import { withdrawFindingAction } from "./actions";
import { GapRow } from "./GapRow";

// Server actions of this page re-test with the model (pipeline/guard.ts: ACTION_MAX_DURATION_S).
export const maxDuration = 300;

export default function FirstWeeksPage({ params }: { params: WsParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <FirstWeeks params={params} />
    </Suspense>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function FirstWeeks({ params }: { params: WsParams }) {
  const { id, role, roleName, pack } = await loadWorkspace(params);
  const approverName = roleLabel(pack.approverRole as RoleKey, pack);
  const successorName = roleLabel(pack.successorRole as RoleKey, pack);
  const [fw, findings] = await Promise.all([firstWeeks(id, role), listFindings(id, role)]);

  const head = (
    <PageHead module="relay" step="After handover" title="First weeks">
      The handover is approved, but some gaps are still open. Work through them here. When you find an answer, record it.
      The approver checks it, then the handover is updated.
    </PageHead>
  );

  if (!fw.hasSnapshot) {
    return (
      <>
        {head}
        <EmptyState title="No approved handover yet.">
          First weeks starts after the approver approves a snapshot. Go to{" "}
          <Link className="underline" href={`/w/${id}/review`}>Review</Link>.
        </EmptyState>
      </>
    );
  }

  const open = fw.blocking.length + fw.other.length;
  const waiting = findings.filter((f) => f.status === "pending").length;
  const isSuccessor = fw.viewer === "successor";

  return (
    <>
      {head}

      {fw.viewer === "approver" ? (
        <div className="mb-6">
          <Notice tone="info" title={`Viewing as ${approverName}.`}>
            You can see every finding here. Approve or reject them on{" "}
            <Link className="underline" href={`/w/${id}/review#findings`}>Review</Link>.
          </Notice>
        </div>
      ) : fw.viewer === "leaving" ? (
        <div className="mb-6">
          <Notice tone="info" title={`Viewing as ${roleName}: read only.`}>Findings are recorded by {successorName}.</Notice>
        </div>
      ) : fw.viewer === "other" ? (
        <div className="mb-6">
          <Notice tone="info" title={`Viewing as ${roleName}: read only.`}>Only {successorName} records findings.</Notice>
        </div>
      ) : null}

      <p className="mb-6 text-sm text-ink-2" role="status" aria-label="First weeks summary">
        {plural(open, "open gap", "open gaps")} · {plural(waiting, "finding", "findings")} waiting for review ·{" "}
        {fw.counts.closed} closed since v1
        <span className="text-muted"> · handover v{fw.latestVersion}</span>
      </p>

      <section aria-labelledby="gaps-h">
        <h2 id="gaps-h" className="text-xl">Open gaps</h2>
        {open === 0 ? (
          <p className="mt-3 text-sm text-ok">
            <span aria-hidden="true">✓ </span>
            {isSuccessor || fw.viewer === "approver" ? "Every gap is closed. Nothing left to find." : "No open blocking gaps."}
          </p>
        ) : (
          <>
            <div className="mt-4">
              <h3 className="text-lg">Blocking gaps</h3>
              <p className="text-sm text-muted">Each one has an owner and a due date from the continuation plan.</p>
              {fw.blocking.length === 0 ? (
                <p className="mt-2 text-sm text-ok"><span aria-hidden="true">✓ </span>No open blocking gaps.</p>
              ) : (
                <ul className="mt-2 grid gap-2" aria-label="Blocking gaps">
                  {fw.blocking.map((g) => (
                    <GapRow key={`${g.responsibilityId}|${g.checkKey}`} ws={id} row={g} roles={fw.roleChoices} approverLabel={approverName} />
                  ))}
                </ul>
              )}
            </div>
            {fw.other.length > 0 && (
              <div className="mt-6">
                <h3 className="text-lg">Other open gaps</h3>
                <p className="text-sm text-muted">Not blocking, but still unanswered.</p>
                <ul className="mt-2 grid gap-2" aria-label="Other open gaps">
                  {fw.other.map((g) => (
                    <GapRow key={`${g.responsibilityId}|${g.checkKey}`} ws={id} row={g} roles={fw.roleChoices} approverLabel={approverName} />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {fw.closed.length > 0 && (
          <div className="mt-6">
            <h3 className="text-lg">Closed since v1</h3>
            <p className="text-sm text-muted">Closed by an approved finding.</p>
            <ul className="mt-2 grid gap-2" aria-label="Closed gaps">
              {fw.closed.map((g) => (
                <GapRow key={`${g.responsibilityId}|${g.checkKey}`} ws={id} row={g} roles={fw.roleChoices} approverLabel={approverName} />
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="mt-10" aria-labelledby="findings-h">
        <h2 id="findings-h" className="text-xl">{isSuccessor ? "Your findings" : "Findings"}</h2>
        {findings.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No findings yet.</p>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Gap</th>
                  <th scope="col">Answer</th>
                  <th scope="col">Status</th>
                  <th scope="col">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => <FindingRow key={f.id} f={f} ws={id} canWithdraw={isSuccessor} />)}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-sm">
          <Link className="underline" href={`/w/${id}/handover`}>Open the handover</Link>
          <span className="text-muted"> to see what changed in the latest version.</span>
        </p>
      </section>
    </>
  );
}

function StatusChip({ f }: { f: FindingView }) {
  if (f.status === "approved") {
    return f.version !== null
      ? <Chip symbol="✓" label={`Approved in v${f.version}`} tone="ok" />
      : <Chip symbol="✓" label="Approved, waiting for the next version" tone="warn" />;
  }
  if (f.status === "rejected") return <Chip symbol="✕" label="Rejected" tone="bad" />;
  if (f.status === "withdrawn") return <Chip symbol="↩" label="Withdrawn" tone="hold" />;
  return <Chip symbol="○" label="Waiting for review" tone="info" />;
}

function FindingRow({ f, ws, canWithdraw }: { f: FindingView; ws: string; canWithdraw: boolean }) {
  return (
    <tr>
      <td className="text-sm">{f.gap}</td>
      <td className="text-sm">
        <p className="font-medium text-ink">{f.answer}</p>
        {f.note && <p className="text-muted">{f.note}</p>}
        {f.link && (
          <p className="text-xs text-muted">
            Link: <span className="mono break-all">{f.link}</span> (not opened by Understudy)
          </p>
        )}
        {f.fileName && (
          <p className="text-xs text-muted">
            File: {f.fileName}{f.fileBytes !== null && `, ${Math.max(1, Math.round(f.fileBytes / 1024))} KB`}
          </p>
        )}
        {f.narrowedTo && <p className="text-xs text-muted">Visible to: {f.narrowedTo.join(", ")}</p>}
      </td>
      <td className="text-sm">
        <StatusChip f={f} />
        {f.status === "rejected" && f.reviewNote && <p className="mt-1 text-bad">Reason: &ldquo;{f.reviewNote}&rdquo;</p>}
        {f.status === "approved" && f.scoreDelta && <p className="mono mt-1 text-xs text-ink-2">{f.scoreDelta}</p>}
      </td>
      <td className="text-sm">
        {when(f.recordedAt)}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Link className="text-attest underline" href={`/w/${ws}/source/${f.segmentId}?claim=${f.claimId}`}>Open evidence</Link>
          {canWithdraw && f.status === "pending" && (
            <ActionForm action={withdrawFindingAction} hidden={{ ws, findingId: f.id }}>
              <SubmitButton className="btn-quiet btn-sm" pendingText="Withdrawing…">Withdraw</SubmitButton>
            </ActionForm>
          )}
        </div>
      </td>
    </tr>
  );
}
