import { Suspense } from "react";
import Link from "next/link";
import { getSegment, listClaims } from "@/lib/db/queries";
import { first, loadWorkspace, type SearchParams } from "@/lib/page";
import { roleLabel } from "@/lib/pack";
import { PageHead, PageLoading } from "@/components/PageHead";
import { RoleChip, TrustChip } from "@/components/chips";
import { Notice } from "@/components/Notice";
import { SegmentText } from "@/components/SegmentText";
import { QuoteText } from "./QuoteText";

type Params = Promise<{ id: string; segmentId: string }>;

export default function SourcePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Source params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";
}

async function Source({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const p = await params;
  const { id, role, roleName, pack } = await loadWorkspace(Promise.resolve({ id: p.id }));
  const sp = await searchParams;
  const claimId = first(sp.claim);
  const view = await getSegment(id, p.segmentId, role);
  const claim = claimId ? (await listClaims(id, { role })).find((c) => c.id === claimId) ?? null : null;
  const citeIndex = Number(first(sp.cite));
  const byIndex = Number.isInteger(citeIndex) ? claim?.citations[citeIndex] : undefined;
  const citation =
    (byIndex && byIndex.segmentId === p.segmentId ? byIndex : null) ??
    claim?.citations.find((c) => c.segmentId === p.segmentId) ??
    null;
  const quote = citation?.quote ?? null;
  const back = (
    <Link href={`/w/${id}/claims`} className="btn btn-quiet btn-sm">
      <span aria-hidden="true">←</span> Back to claims
    </Link>
  );

  if (!view) {
    return (
      <>
        <PageHead module="attest" step="Evidence" title="Source segment" aside={back} />
        <Notice tone="warn" title="This segment is not visible to your role.">
          You are viewing as {roleName}. Its source is shared with other roles only, or it does not exist in this
          workspace. Nothing about its content is shown.
        </Notice>
      </>
    );
  }

  const s = view.segment;
  return (
    <>
      <PageHead module="attest" step="Evidence" title={view.sourceName} aside={back}>
        <span className="mono text-sm text-muted">{s.id}</span>
        {s.version > 1 && <span className="ml-2 text-sm text-muted">version {s.version}</span>}
      </PageHead>

      {claim && (
        <section className="card mb-4 p-4" aria-label="Cited by">
          <p className="eyebrow">Cited by</p>
          <div className="mt-1 flex flex-wrap items-start justify-between gap-2">
            <p className="text-ink">{claim.statement}</p>
            <TrustChip trust={claim.trust} />
          </div>
          {citation && !citation.accepted && (
            <p className="mt-1 text-xs text-bad">
              <span aria-hidden="true">✕ </span>Citation not accepted: this segment was not in the batch the model was shown.
            </p>
          )}
          {quote && citation?.exact && (
            <p className="mt-1 text-xs text-muted">The highlighted text below is the exact quote this claim relies on.</p>
          )}
          {claim.stateNote && <p className="mt-1 text-xs text-ink-2">{claim.stateNote}</p>}
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <article className="card min-w-0 p-4 sm:p-6">
          {citation ? (
            <QuoteText text={s.text} quote={quote} exact={Boolean(citation.exact && citation.accepted)} />
          ) : (
            <SegmentText text={s.text} quote={null} />
          )}
        </article>
        <aside className="card grid content-start gap-3 p-4 text-sm">
          <div>
            <p className="eyebrow">Source</p>
            <p>{view.sourceName}</p>
            <p className="text-xs text-muted">{s.sourceKind} · {s.kind}</p>
          </div>
          <div>
            <p className="eyebrow">Author</p>
            <p>{view.authorName ?? "Unknown"}</p>
          </div>
          <div>
            <p className="eyebrow">Time</p>
            <p>{when(s.ts)}</p>
          </div>
          <div>
            <p className="eyebrow">Thread</p>
            <p className="break-words">{s.thread}</p>
          </div>
          <div>
            <p className="eyebrow">Who can see it</p>
            <p className="mt-1 flex flex-wrap gap-1">
              {s.roleSet.map((r) => (
                <RoleChip key={r} role={r} label={roleLabel(r, pack)} />
              ))}
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
