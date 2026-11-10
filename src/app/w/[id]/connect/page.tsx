import { Suspense } from "react";
import { getRunStatus, listSources } from "@/lib/db/queries";
import { modelAvailable, modelTag } from "@/lib/model/client";
import { dataLevel, DATA_LEVEL_LABEL } from "@/lib/tether/data-level";
import { loadWorkspace, roleOptions, type WsParams } from "@/lib/page";
import { roleLabel } from "@/lib/pack";
import { PageHead, PageLoading } from "@/components/PageHead";
import { RunPanel } from "@/components/RunPanel";
import { UploadForm } from "@/components/UploadForm";
import { RoleChip } from "@/components/chips";
import { EmptyState, Notice } from "@/components/Notice";
import type { SourceKind } from "@/lib/types";

export const maxDuration = 60;

const KIND_LABEL: Record<SourceKind, string> = {
  tasks_csv: "Task board",
  whatsapp: "WhatsApp",
  slack: "Slack",
  github: "GitHub",
  markdown: "Notes",
  ics: "Calendar",
  interview: "Leaver answers",
};

const LEVEL_LINE: Record<string, string> = {
  L0: "No sources yet: nothing to reconstruct.",
  L1: "Task board only: owners, statuses and dates, but little of the how and why.",
  L2: "Task board plus conversation: the how and why start to appear.",
  L3: "Task board, conversation and code/config: the fullest picture of what the leaver did.",
};

export default function ConnectPage({ params }: { params: WsParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Connect params={params} />
    </Suspense>
  );
}

async function Connect({ params }: { params: WsParams }) {
  const { id, pack } = await loadWorkspace(params);
  const [sources, run, modelUp] = await Promise.all([listSources(id), getRunStatus(id), modelAvailable()]);
  const level = dataLevel(sources.map((s) => s.kind));
  const imported = sources.filter((s) => s.kind !== "interview");

  return (
    <>
      <PageHead module="tether" step="Step 1" title="Connect the record">
        Everything Understudy knows comes from these sources. Secrets are removed and contacts are masked before
        anything is stored.
      </PageHead>

      {!modelUp && (
        <div className="mb-5">
          <Notice tone="warn" title="Model unavailable">
            The language model ({modelTag()}) is not reachable. Structured sources (task board, calendar) and cached
            answers still work; free-text extraction waits until it is back.
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 gap-6">
          <section aria-labelledby="src-h" className="card min-w-0 p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="src-h" className="text-xl">Sources</h2>
              <p className="text-sm text-muted">{imported.length} connected</p>
            </div>
            {sources.length === 0 ? (
              <div className="mt-4">
                <EmptyState title="No sources yet. Upload a file or open the demo.">
                  Use the upload form on this page, or go back to the start page and open the robotics-club demo.
                </EmptyState>
              </div>
            ) : (
              <div className="table-wrap mt-3">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Source</th>
                      <th scope="col">Who can see it</th>
                      <th scope="col" className="text-right">Segments</th>
                      <th scope="col" className="text-right">Masked</th>
                      <th scope="col">Rejected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => (
                      <tr key={s.id}>
                        <td className="min-w-[10rem]">
                          <span className="block font-medium">{s.name}</span>
                          <span className="text-xs text-muted">{KIND_LABEL[s.kind]}</span>
                        </td>
                        <td className="min-w-[12rem]">
                          <span className="flex flex-wrap gap-1">
                            {s.roleSet.map((r) => (
                              <RoleChip key={r} role={r} label={roleLabel(r, pack)} />
                            ))}
                          </span>
                        </td>
                        <td className="mono text-right">{s.segmentCount}</td>
                        <td className="whitespace-nowrap text-right text-xs">
                          <span className="block">{s.maskedSecrets} {s.maskedSecrets === 1 ? "secret" : "secrets"}</span>
                          <span className="block text-muted">{s.maskedContacts} {s.maskedContacts === 1 ? "contact" : "contacts"}</span>
                        </td>
                        <td className="min-w-[8rem] text-xs">
                          {s.rejected.length === 0 ? (
                            <span className="text-muted">None</span>
                          ) : (
                            <details>
                              <summary className="cursor-pointer text-bad">
                                {s.rejected.length} row{s.rejected.length === 1 ? "" : "s"} rejected
                              </summary>
                              <ul className="mt-1 grid gap-1">
                                {s.rejected.slice(0, 20).map((r, i) => (
                                  <li key={i}>
                                    <span className="mono">line {r.line}</span>: {r.reason}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <RunPanel ws={id} initial={run} hasSources={imported.length > 0} />
        </div>

        <aside className="grid min-w-0 grid-cols-1 content-start gap-6">
          <section aria-labelledby="lvl-h" className="card p-4 sm:p-5">
            <h2 id="lvl-h" className="eyebrow">Data level</h2>
            <p className="mt-2 font-serif text-3xl">
              {level} <span className="text-lg text-ink-2">{DATA_LEVEL_LABEL[level]}</span>
            </p>
            <p className="mt-2 text-sm text-muted">{LEVEL_LINE[level]}</p>
          </section>
          <section aria-label="Add sources" className="card p-4 sm:p-5">
            <UploadForm ws={id} roles={roleOptions(pack)} />
            <p className="mt-4 text-xs text-muted">Don&apos;t upload confidential material. Synthetic or public data only.</p>
          </section>
        </aside>
      </div>
    </>
  );
}
