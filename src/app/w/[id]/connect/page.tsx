import { Suspense } from "react";
import { getRunStatus, listSources } from "@/lib/db/queries";
import { modelAvailable, modelTag } from "@/lib/model/client";
import { publicRun } from "@/lib/pipeline/public-run";
import { dataLevel, DATA_LEVEL_LABEL } from "@/lib/tether/data-level";
import { loadWorkspace, roleOptions, type WsParams } from "@/lib/page";
import { roleLabel } from "@/lib/pack";
import { PageHead, PageLoading } from "@/components/PageHead";
import { RunPanel } from "@/components/RunPanel";
import { UploadForm } from "@/components/UploadForm";
import { RoleChip } from "@/components/chips";
import { EmptyState, Notice } from "@/components/Notice";
import type { SourceKind } from "@/lib/types";
import { limitedPerSource, SensitivePanel } from "./SensitivePanel";

// Widening a message re-runs the pipeline inside after(): the same limit as the run route.
export const maxDuration = 300;

const KIND_LABEL: Record<SourceKind, string> = {
  tasks_csv: "Task board",
  whatsapp: "WhatsApp",
  slack: "Slack",
  github: "GitHub",
  markdown: "Notes",
  ics: "Calendar",
  interview: "Leaver answers",
  finding: "Successor findings",
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
  const { id, pack, role } = await loadWorkspace(params);
  const [sources, run, modelUp, limited] = await Promise.all([
    listSources(id), getRunStatus(id), modelAvailable(), limitedPerSource(id, role),
  ]);
  const level = dataLevel(sources.map((s) => s.kind));
  // Answers and findings are a person's words collected by Understudy, not connected sources.
  const imported = sources.filter((s) => s.kind !== "interview" && s.kind !== "finding");

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
                <EmptyState title="No sources yet. Upload a file or open a demo.">
                  Use the upload form on this page, or go back to the start page and open a demo.
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
                        <td className="mono text-right">
                          {s.segmentCount}
                          {limited[s.id] ? <span className="block font-sans text-xs text-muted">{limited[s.id]} limited</span> : null}
                        </td>
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

          {sources.length > 0 && (
            <Suspense fallback={<section className="card p-4 sm:p-5" aria-busy="true"><h2 className="text-xl">Sensitive content</h2></section>}>
              <SensitivePanel ws={id} role={role} pack={pack} running={run?.status === "running"} />
            </Suspense>
          )}

          {/* Keyed by run: a run started by a widen (a server action) gets a fresh, polling panel. */}
          <RunPanel key={run?.id ?? "none"} ws={id} initial={publicRun(run)} hasSources={imported.length > 0} />
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
