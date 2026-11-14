import { Suspense } from "react";
import Link from "next/link";
import { loadWorkspace } from "@/lib/page";
import { actorLabel, getClaimHistory, type HistoryEntry } from "@/lib/attest/history";
import type { ResolvedPack } from "@/lib/pack";
import { PageHead, PageLoading } from "@/components/PageHead";
import { StateChip, TrustChip } from "@/components/chips";
import { Notice } from "@/components/Notice";
import { CitationLinks } from "../CitationLinks";

type Params = Promise<{ id: string; claimId: string }>;

export default function ClaimHistoryPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <History params={params} />
    </Suspense>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";
}

async function History({ params }: { params: Params }) {
  const p = await params;
  const { id, role, roleName, pack } = await loadWorkspace(Promise.resolve({ id: p.id }));
  // The role comes from the server-side cookie reader (loadWorkspace), never from the request body.
  const history = await getClaimHistory(id, p.claimId, role);
  const back = (claimId?: string) => (
    <Link href={`/w/${id}/claims${claimId ? `#${claimId}` : ""}`} className="btn btn-quiet btn-sm">
      <span aria-hidden="true">←</span> Back to claims
    </Link>
  );

  if (!history) {
    return (
      <>
        <PageHead module="attest" step="History" title="Claim not found" aside={back()} />
        <Notice tone="warn" title="There is no such claim for your role.">
          You are viewing as {roleName}. The claim does not exist in this workspace, or your role cannot see it.
          Nothing about it is shown. <Link href={`/w/${id}/claims`} className="underline">Back to claims</Link>
        </Notice>
      </>
    );
  }

  const { claim, entries, changes } = history;
  return (
    <>
      <PageHead module="attest" step="History" title="Claim history" aside={back(claim.id)}>
        Every change to this claim, oldest first. Showing what <strong>{roleName}</strong> may see.
      </PageHead>

      <section className="card mb-4 p-4" aria-label="The claim">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="max-w-3xl text-[0.98rem] text-ink">{claim.statement}</p>
          <span className="flex flex-wrap gap-1.5">
            <TrustChip trust={claim.trust} />
            <StateChip state={claim.state} note={claim.stateNote} />
          </span>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {claim.entityLabel} · <span className="mono">{claim.attribute}</span> · <span className="mono">{claim.value}</span>
        </p>
        <CitationLinks claim={claim} ws={id} />
      </section>

      {changes === 0 && (
        <div className="mb-4">
          <Notice title="No changes since this claim was created." />
        </div>
      )}

      {entries.length > 0 && (
        <ol className="grid gap-2 border-l-2 border-rule pl-4" aria-label="Timeline">
          {entries.map((e) => (
            <Entry key={e.id} e={e} ws={id} claimId={claim.id} pack={pack} />
          ))}
        </ol>
      )}
    </>
  );
}

function Entry({ e, ws, claimId, pack }: { e: HistoryEntry; ws: string; claimId: string; pack: ResolvedPack }) {
  return (
    <li className="card p-3 text-sm" data-kind={e.kind}>
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium text-ink">{e.title}</span>
        <span className="text-xs text-muted">
          <time dateTime={e.at}>{when(e.at)}</time> · by {actorLabel(e.actor, pack)}
        </span>
      </p>
      {e.rule && (
        <p className="mt-1 text-ink-2">
          <span className="font-medium">Rule: </span>
          {e.rule}
        </p>
      )}
      {e.lines.length > 0 && (
        <ul className="mt-1 grid gap-0.5 text-ink-2">
          {e.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {e.related && (
        <p className="mt-1 text-xs">
          {e.related.relation}{" "}
          <Link href={`/w/${ws}/claims/${e.related.id}`} className="text-attest underline">
            {e.related.statement}
          </Link>
        </p>
      )}
      {e.segmentId && (
        <p className="mt-1 text-xs">
          <Link href={`/w/${ws}/source/${e.segmentId}?claim=${claimId}`} className="text-attest underline">
            Open the source of this change
          </Link>
        </p>
      )}
    </li>
  );
}
