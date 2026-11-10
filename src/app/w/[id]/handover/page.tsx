import { Suspense } from "react";
import Link from "next/link";
import { compileHandover } from "@/lib/relay";
import { loadWorkspace, type WsParams } from "@/lib/page";
import { PageHead, PageLoading } from "@/components/PageHead";
import { TrustChip } from "@/components/chips";
import { ScoreLine } from "@/components/Scores";
import { EmptyState, Notice } from "@/components/Notice";

export default function HandoverPage({ params }: { params: WsParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Handover params={params} />
    </Suspense>
  );
}

async function Handover({ params }: { params: WsParams }) {
  const { id, role, roleName } = await loadWorkspace(params);
  const h = await compileHandover(id, role);

  return (
    <>
      <PageHead module="relay" step="Step 7" title={`Handover for ${roleName}`}>
        Compiled from the approved snapshot, read under this role&apos;s permissions. Switch &ldquo;Viewing as&rdquo; to compare
        roles.
      </PageHead>

      {!h.snapshot ? (
        <EmptyState title="No approved snapshot yet.">
          The Club President approves one on <Link className="underline" href={`/w/${id}/review`}>Review</Link>.
        </EmptyState>
      ) : (
        <>
          <section className="card mb-5 grid gap-2 p-4 sm:p-5" aria-label="Workstream status">
            <p className="eyebrow">Workstream status</p>
            <p className="text-sm">
              Snapshot <span className="mono">v{h.snapshot.version}</span> · SHA-256{" "}
              <span className="mono break-all text-xs">{h.snapshot.hash}</span>
            </p>
            <p className="font-medium">
              {h.releaseLine ? (
                <span className="text-warn">
                  <span aria-hidden="true">! </span>
                  {h.releaseLine}
                </span>
              ) : (
                <span className="text-ok">
                  <span aria-hidden="true">✓ </span>Released with no open blocking gaps
                </span>
              )}
            </p>
            {h.scores && (
              <p>
                <ScoreLine scores={h.scores} provisional={false} />
              </p>
            )}
          </section>

          {h.stubLine && (
            <div className="mb-5">
              <Notice tone="info" title="Restricted">
                {h.stubLine}
              </Notice>
            </div>
          )}

          {h.groups.length === 0 ? (
            <EmptyState title="Nothing in this snapshot is visible to this role." />
          ) : (
            <div className="grid gap-5">
              {h.groups.map((g) => (
                <section key={g.attribute} className="card p-4 sm:p-5" aria-labelledby={`g-${g.attribute}`}>
                  <h2 id={`g-${g.attribute}`} className="text-xl">
                    {g.label}
                  </h2>
                  <ul className="mt-3 grid gap-2">
                    {g.items.map((it) => (
                      <li key={it.claimId} className="flex flex-wrap items-start justify-between gap-2 border-t border-rule pt-2">
                        <span className="max-w-3xl">
                          <span className="block text-xs text-muted">{it.entityLabel}</span>
                          {it.statement}
                        </span>
                        <TrustChip trust={it.trust} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
