import { Suspense } from "react";
import Link from "next/link";
import clsx from "clsx";
import { roleLabel } from "@/lib/pack";
import { loadWorkspace, type WsParams } from "@/lib/page";
import { compileHandover, listAcknowledgements, resolveReadbackItems } from "@/lib/relay";
import { visibilityChangedSinceSnapshot } from "@/lib/tether/visibility";
import type { HandoverLine, HandoverSection } from "@/lib/relay/core/compile";
import { REVIEWER_EDITED_LABEL } from "@/lib/relay/core/labels";
import { PageHead, PageLoading } from "@/components/PageHead";
import { Chip, TrustChip } from "@/components/chips";
import { OpenGapsNote, ScoreLine } from "@/components/Scores";
import { EmptyState } from "@/components/Notice";
import type { RoleKey } from "@/lib/types";
import { latestChange } from "@/lib/relay/living";
import { WhatChanged } from "@/components/WhatChanged";
import { ReadbackForm, type ReadbackField } from "./ReadbackForm";
import { LeakFallback, LeakGrid } from "./LeakGrid";

// "Run probes again" asks the model judge inside a time box of 40 seconds.
export const maxDuration = 60;

export default function HandoverPage({ params }: { params: WsParams }) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Handover params={params} />
    </Suspense>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";
}

const EDITED_SUFFIX = ` (${REVIEWER_EDITED_LABEL})`;

async function Handover({ params }: { params: WsParams }) {
  const { id, role, roleName, pack } = await loadWorkspace(params);
  const h = await compileHandover(id, role);
  const approverName = roleLabel(pack.approverRole as RoleKey, pack);

  if (!h.doc || !h.snapshot) {
    return (
      <>
        <PageHead module="relay" step="Step 7" title={`Handover for ${roleName}`}>
          Compiled from the approved snapshot, read under this role&apos;s permissions.
        </PageHead>
        <EmptyState title="The approver hasn't approved a handover yet.">
          Switch to {approverName} and go to <Link className="underline" href={`/w/${id}/review`}>Review</Link>.
        </EmptyState>
      </>
    );
  }

  const { doc, snapshot } = h;
  const [acks, resolved, change, visibilityChanged] = await Promise.all([
    listAcknowledgements(id), resolveReadbackItems(id, snapshot.id), latestChange(id, role), visibilityChangedSinceSnapshot(id),
  ]);
  const hasRecord = new Map(resolved.items.map((i) => [i.key, i.expectedClaimId !== null]));
  const fields: ReadbackField[] = doc.readbackForm.map((f) => ({ ...f, hasRecord: hasRecord.get(f.key) ?? false }));
  const synthesis = doc.sections.find((s) => s.key === "synthesis");

  // One footnote number per evidence segment, in reading order.
  const cite = new Map<string, number>();
  for (const s of doc.sections) for (const l of s.lines) for (const seg of l.segmentIds) if (!cite.has(seg)) cite.set(seg, cite.size + 1);

  const blocking = snapshot.openBlocking;
  const isLeaver = role === pack.leaverRole;

  return (
    <>
      <PageHead
        module="relay"
        step="Step 7"
        title={`Handover for ${roleName}`}
        aside={
          <a href={`/api/w/${id}/export`} download className="btn btn-quiet btn-sm">
            <span aria-hidden="true">↓ </span>Download handover (Markdown)
          </a>
        }
      >
        Compiled from the approved snapshot through fixed templates, read under this role&apos;s permissions. Switch
        &ldquo;Viewing as&rdquo; to compare roles.
      </PageHead>

      {visibilityChanged && (
        <p role="status" className="mb-4 rounded-md border border-warn bg-[#fbf6ea] px-4 py-3 text-sm">
          <span aria-hidden="true">! </span>
          Visibility changed after this snapshot was approved. Approve a new snapshot to apply it.
        </p>
      )}

      {/* Release banner */}
      <section className="card mb-6 overflow-hidden" aria-labelledby="release-h">
        <div className={clsx("border-l-4 p-4 sm:p-6", blocking > 0 ? "border-warn" : "border-relay")}>
          <p className="eyebrow text-relay">Approved by {roleLabel(snapshot.approvedBy, pack)} · {when(snapshot.approvedAt)}</p>
          <h2 id="release-h" className="mt-1 flex flex-wrap items-center gap-3 font-serif text-2xl sm:text-3xl">
            {doc.snapshot.releaseLabel}
            {blocking > 0 && <Chip symbol="!" label="Open items below" tone="warn" />}
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-2">
            <span>
              Snapshot <span className="mono">v{snapshot.version}</span>
            </span>
            <span title={snapshot.hash}>
              SHA-256 <span className="mono">{snapshot.hash.slice(0, 12)}</span>
            </span>
            {h.verified ? (
              <span className="text-ok"><span aria-hidden="true">✓ </span>Hash verified</span>
            ) : (
              <span className="text-bad"><span aria-hidden="true">✕ </span>Hash does not verify</span>
            )}
            {h.scores && <ScoreLine scores={h.scores} provisional={false} />}
          </div>
          {h.scores && <OpenGapsNote b={h.scores.b} open={blocking} />}
          {h.withheld > 0 && (
            <p className="mt-3 text-sm text-muted">
              <span aria-hidden="true">⊘ </span>
              {h.stubLine}
            </p>
          )}
        </div>
      </section>

      {/* Living handover: the way to First weeks, and what the latest version changed (role-scoped) */}
      {blocking > 0 && (
        <p className="mb-6 text-sm text-ink-2">
          Some gaps are still open.{" "}
          {role === pack.successorRole
            ? "Record what you find in your first weeks."
            : `${roleLabel(pack.successorRole as RoleKey, pack)} records what they find in their first weeks.`}{" "}
          <Link className="font-medium text-attest underline" href={`/w/${id}/first-weeks`}>Go to First weeks</Link>
        </p>
      )}
      {change && change.version > 1 && <WhatChanged view={change} ws={id} />}

      {/* The I-PASS document */}
      <article className="card p-4 sm:p-8" aria-label={`Handover document for ${roleName}`}>
        <div className="grid gap-8">
          {doc.sections.map((s) => (
            <Section key={s.key} section={s} ws={id} cite={cite}>
              {s.key === "synthesis" && (
                <div className="mt-3">
                  <p className="mb-3 text-sm text-muted">
                    Type each critical item from memory. Dates, contacts and commands are normalised, then compared exactly
                    with the approved snapshot.
                  </p>
                  <ReadbackForm
                    ws={id}
                    fields={fields}
                    hidden={synthesis?.withheld ?? 0}
                    canAck={!isLeaver}
                    ackNote={isLeaver ? "The leaver hands over; receipt is acknowledged by the people taking over." : null}
                  />
                </div>
              )}
            </Section>
          ))}
        </div>
        {cite.size > 0 && (
          <p className="mt-8 border-t border-rule pt-3 text-xs text-muted">
            Numbers in brackets open the source evidence with the quote highlighted. Trust labels are in words; nothing a
            person said is labelled verified.
          </p>
        )}
      </article>

      {/* Acknowledgements */}
      <section className="mt-8" aria-labelledby="ack-h">
        <h2 id="ack-h" className="text-xl">Acknowledgements</h2>
        <p className="mt-1 text-sm text-muted">Append-only: each row records the role, the time, the snapshot hash and the verdict per item.</p>
        {acks.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No one has acknowledged receipt yet.</p>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Role</th>
                  <th scope="col">Snapshot</th>
                  <th scope="col">Read-back</th>
                </tr>
              </thead>
              <tbody>
                {acks.map((a) => (
                  <tr key={a.id}>
                    <td className="text-sm">{when(a.at)}</td>
                    <td className="text-sm">{a.roleLabel}</td>
                    <td>
                      <span className="mono">{a.snapshotId.replace(/^snap_/, "")}</span>{" "}
                      <span className="mono text-xs text-muted">{a.snapshotHash.slice(0, 12)}</span>
                    </td>
                    <td className="text-sm">
                      {a.allMatched ? (
                        <Chip symbol="✓" label={`All ${a.match} matched`} tone="ok" />
                      ) : (
                        <Chip symbol="!" label={`${a.match} matched · ${a.mismatch} mismatched`} tone="warn" />
                      )}
                      {a.notVisible > 0 && <span className="ml-2 text-xs text-muted">{a.notVisible} not checked</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Leak check */}
      <Suspense fallback={<LeakFallback />}>
        <LeakGrid ws={id} isApprover={role === pack.approverRole} />
      </Suspense>
    </>
  );
}

const SECTION_MARK: Record<HandoverSection["key"], string> = {
  status: "I", summary: "P", actions: "A", risks: "S", synthesis: "S", timeline: "◷", open_items: "!",
};

function Section({
  section: s, ws, cite, children,
}: { section: HandoverSection; ws: string; cite: Map<string, number>; children?: React.ReactNode }) {
  const lines = s.key === "synthesis" ? s.lines.filter((l) => l.kind === "stub" || l.kind === "empty") : s.lines;
  const mark = SECTION_MARK[s.key];
  return (
    <section aria-labelledby={`sec-${s.key}`}>
      <header className="flex items-baseline gap-3 border-b border-rule pb-2">
        <span
          aria-hidden="true"
          className={clsx(
            "inline-flex h-8 w-8 flex-none items-center justify-center rounded-full font-serif text-lg",
            s.letter ? "bg-relay text-card" : "border border-rule-strong text-ink-2",
          )}
        >
          {mark}
        </span>
        <h2 id={`sec-${s.key}`} className="text-xl">
          {s.letter && <span className="sr-only">{s.letter}: </span>}
          {s.title}
        </h2>
      </header>
      {s.key === "timeline" ? (
        <ol className="mt-3 grid gap-0 border-l border-rule pl-5">
          {lines.map((l, i) => <TimelineItem key={i} line={l} ws={ws} cite={cite} />)}
        </ol>
      ) : (
        lines.length > 0 && (
          <ul className="mt-3 grid gap-2">
            {lines.map((l, i) => <Line key={i} line={l} ws={ws} cite={cite} first={s.key === "status" && i === 0} />)}
          </ul>
        )
      )}
      {children}
    </section>
  );
}

function Cites({ line, ws, cite }: { line: HandoverLine; ws: string; cite: Map<string, number> }) {
  if (!line.segmentIds.length) return null;
  return (
    <span className="ml-1 whitespace-nowrap text-xs">
      {line.segmentIds.map((seg) => (
        <Link
          key={seg}
          href={`/w/${ws}/source/${seg}${line.claimIds[0] ? `?claim=${line.claimIds[0]}` : ""}`}
          className="ml-0.5 text-attest underline"
          aria-label={`Evidence ${cite.get(seg)}`}
        >
          [{cite.get(seg)}]
        </Link>
      ))}
    </span>
  );
}

function lineText(l: HandoverLine): string {
  return l.edited && l.text.endsWith(EDITED_SUFFIX) ? l.text.slice(0, -EDITED_SUFFIX.length) : l.text;
}

function Line({ line: l, ws, cite, first }: { line: HandoverLine; ws: string; cite: Map<string, number>; first?: boolean }) {
  if (l.kind === "stub") {
    return (
      <li className="flex items-start gap-2 rounded-md border border-dashed border-rule-strong bg-paper px-3 py-2 text-sm text-ink-2">
        <span aria-hidden="true" className="text-hold">⊘</span>
        <span>{l.text}</span>
      </li>
    );
  }
  if (l.kind === "empty") return <li className="text-sm text-muted">{l.text}</li>;
  return (
    <li
      className={clsx(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-1",
        l.kind === "plan" && "rounded-md border-l-4 border-warn bg-[#fbf6ea] px-3 py-2",
        l.kind === "conflict" && "rounded-md border-l-4 border-bad bg-[#fbf0f1] px-3 py-2",
      )}
    >
      <span className={clsx("min-w-0 max-w-3xl flex-1", first && "font-semibold", l.kind === "status" && !first && "text-ink-2")}>
        {lineText(l)}
        <Cites line={l} ws={ws} cite={cite} />
      </span>
      {(l.trust || l.edited || l.kind === "plan" || l.kind === "conflict") && (
        <span className="flex flex-wrap gap-1.5">
          {l.trust && <TrustChip trust={l.trust} />}
          {l.edited && <Chip symbol="✎" label={REVIEWER_EDITED_LABEL} tone="plain" />}
          {l.kind === "plan" && <Chip symbol="!" label="Open item" tone="warn" />}
          {l.kind === "conflict" && <Chip symbol="⇄" label="Conflicting" tone="bad" />}
        </span>
      )}
    </li>
  );
}

function TimelineItem({ line: l, ws, cite }: { line: HandoverLine; ws: string; cite: Map<string, number> }) {
  if (l.kind === "stub" || l.kind === "empty") {
    return (
      <li className={clsx("relative py-2 text-sm", l.kind === "stub" ? "text-ink-2" : "text-muted")}>
        {l.kind === "stub" && <span aria-hidden="true" className="mr-1 text-hold">⊘</span>}
        {l.text}
      </li>
    );
  }
  const text = lineText(l);
  const sep = text.indexOf(" · ");
  const date = sep > 0 ? text.slice(0, sep) : l.date ?? "";
  const body = sep > 0 ? text.slice(sep + 3) : text;
  return (
    <li className="relative py-2">
      <span aria-hidden="true" className="absolute -left-[1.6rem] top-3.5 h-2.5 w-2.5 rounded-full border-2 border-relay bg-card" />
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 max-w-3xl flex-1">
          <span className="mono mr-2 text-muted">{date}</span>
          {body}
          <Cites line={l} ws={ws} cite={cite} />
        </p>
        <span className="flex flex-wrap gap-1.5">
          {l.trust && <TrustChip trust={l.trust} />}
          {l.edited && <Chip symbol="✎" label={REVIEWER_EDITED_LABEL} tone="plain" />}
        </span>
      </div>
    </li>
  );
}
