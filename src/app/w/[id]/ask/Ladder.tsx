// The ladder: one card per gap, three rungs each (people, files and history, possible answers).
// Every row shown here was read under RLS as the viewing role; a rung with no readable row says
// "Nothing here for your role." and cannot be told apart from hidden rows.
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { Chip, TrustChip } from "@/components/chips";
import type { LadderGap, LadderStep, TraceView } from "@/lib/lacuna";
import type { OptionDetail } from "@/lib/lacuna/recovery";
import { switchToRoleAction } from "./actions";
import { TraceSteps } from "./RebuiltProcedures";

const GAP = {
  missing: { symbol: "○", label: "Missing", tone: "bad" as const },
  partial: { symbol: "◐", label: "Partial", tone: "warn" as const },
  conflicting: { symbol: "⇄", label: "Conflicting", tone: "bad" as const },
};

const STATE = {
  closed: { symbol: "●", label: "Closed", tone: "ok" as const },
  partly: { symbol: "◐", label: "Partly answered", tone: "warn" as const },
  open: { symbol: "○", label: "Still open", tone: "bad" as const },
};

const NOTHING_FOR_ROLE = "Nothing here for your role.";

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

function failed(steps: LadderStep[]): LadderStep | undefined {
  return steps.find((s) => s.kind === "none" && s.detail.failed === true);
}

function People({
  ws, steps, viewingRole, roleLabels,
}: { ws: string; steps: LadderStep[]; viewingRole: string; roleLabels: Record<string, string> }) {
  const rows = steps.filter((s) => s.kind === "neighbour");
  const broke = failed(steps);
  if (broke) return <p className="text-sm text-bad">{broke.reason}</p>;
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        {steps.some((s) => s.kind === "none") ? "Nobody else worked on this closely enough to ask." : NOTHING_FOR_ROLE}
      </p>
    );
  }
  return (
    <ul className="grid gap-2 text-sm">
      {rows.map((s) => {
        const name = s.personName ?? "Someone";
        const role = s.targetRole ? roleLabels[s.targetRole] ?? s.targetRole : null;
        const first = name.split(" ")[0];
        return (
          <li key={s.id} data-status={s.status}>
            {s.status === "asked" && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  <strong className="font-semibold">{name}</strong>{role ? ` (${role})` : ""}. {s.reason}. Asked. Waiting for an answer.
                </span>
                {s.targetRole && s.targetRole !== viewingRole ? (
                  <ActionForm action={switchToRoleAction} hidden={{ ws, role: s.targetRole }}>
                    <SubmitButton className="btn-quiet btn-sm" pendingText="Switching…">Switch to {first} to answer</SubmitButton>
                  </ActionForm>
                ) : (
                  <span className="text-muted">Answer under &quot;Questions for you&quot; above.</span>
                )}
              </div>
            )}
            {s.status === "answered" && (
              <div className="grid gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span><strong className="font-semibold">{name}</strong> answered.</span>
                  <TrustChip trust="second_hand" />
                  <Link href={`/w/${ws}/claims?trust=second_hand`} className="text-attest underline">See claim</Link>
                </div>
                {s.statement && <p className="text-ink-2">{s.statement}</p>}
              </div>
            )}
            {s.status === "declined" && <span><strong className="font-semibold">{name}</strong> could not answer.</span>}
            {s.status === "skipped_no_access" && (
              <span>
                <strong className="font-semibold">{name}</strong>{role ? ` (${role})` : ""}. Skipped: no access. This role cannot see the
                topic, so this person was not asked and was shown nothing.
              </span>
            )}
            {s.status === "skipped_no_seat" && (
              <span>
                <strong className="font-semibold">{name}</strong>. Not asked: no role in this handover. Ask outside Understudy and
                record what you learn. <span className="text-muted">({s.reason})</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Files({ ws, steps, traces }: { ws: string; steps: LadderStep[]; traces: Map<string, TraceView> }) {
  const broke = failed(steps);
  if (broke) return <p className="text-sm text-bad">{broke.reason}</p>;
  const found = steps.filter((s) => s.kind === "trace");
  if (found.length > 0) {
    return (
      <div className="grid gap-3">
        {found.map((s) => {
          const t = s.targetRef ? traces.get(s.targetRef) : undefined;
          return (
            <div key={s.id} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <TrustChip trust="inferred" />
                <span className="font-medium">{String(s.detail.title ?? t?.title ?? "Rebuilt from the record")}</span>
              </div>
              {t ? <TraceSteps ws={ws} trace={t} /> : s.statement ? <p className="mt-1 text-ink-2">{s.statement}</p> : null}
            </div>
          );
        })}
      </div>
    );
  }
  const none = steps.find((s) => s.kind === "none");
  if (!none) return <p className="text-sm text-muted">{NOTHING_FOR_ROLE}</p>;
  const text = none.status === "not_applicable"
    ? "Files and history cannot say who. Skipped."
    : none.detail.related === true
      ? "Related history exists, but it does not answer this. See \"Rebuilt procedures\" below."
      : "No workflow file, commit history or calendar entry covers this.";
  return <p className="text-sm text-muted">{text}</p>;
}

function Options({
  ws, steps, names, earlierDateHint,
}: { ws: string; steps: LadderStep[]; names: Record<string, string>; earlierDateHint: boolean }) {
  const broke = failed(steps);
  if (broke) return <p className="text-sm text-bad">{broke.reason}</p>;
  const options = steps.filter((s) => s.kind === "option");
  const none = steps.find((s) => s.kind === "none");
  const rulesOnly = steps.some((s) => s.detail.rulesOnly === true);
  const note = rulesOnly ? <p className="mt-1 text-xs text-muted">Model unavailable: these options come from the rules only.</p> : null;
  if (options.length === 0) {
    if (!none) return <p className="text-sm text-muted">{NOTHING_FOR_ROLE}</p>;
    if (none.status === "not_applicable") return <p className="text-sm text-muted">Not needed. This gap is closed.</p>;
    return (
      <>
        <p className="text-sm text-muted">Nothing on record points to an answer. This gap needs an owner in the continuation plan.</p>
        {note}
      </>
    );
  }
  return (
    <>
      <ul className="grid gap-2 text-sm">
        {options.map((s, i) => {
          const d = s.detail as unknown as OptionDetail & { single?: boolean };
          return (
            <li key={s.id}>
              <div className="flex flex-wrap items-start gap-2">
                <TrustChip trust="ranked_options" />
                <span className="max-w-3xl">
                  <span className="font-medium">{d.single ? "Lead." : `Option ${i + 1}.`}</span> {d.value}
                </span>
              </div>
              <ul className="mt-1 grid gap-0.5 pl-1 text-xs text-ink-2">
                {(d.evidence ?? []).slice(0, 3).map((e) => (
                  <li key={e.claimId}>
                    {e.authorId && names[e.authorId] ? names[e.authorId] : "Someone"} wrote this on {shortDate(e.ts)}
                    {e.sourceName ? ` in ${e.sourceName}` : ""}.{e.quote ? ` "${e.quote.length > 220 ? `${e.quote.slice(0, 219)}…` : e.quote}"` : ""}{" "}
                    {e.segmentId && (
                      <Link href={`/w/${ws}/source/${e.segmentId}?claim=${e.claimId}`} className="text-attest underline">Open source</Link>
                    )}
                  </li>
                ))}
              </ul>
              {d.sources?.includes("model") && <p className="mt-0.5 text-xs text-muted">Suggested from the cited records.</p>}
              {d.sources?.includes("pattern") && !d.sources.includes("conflict") && (
                <p className="mt-0.5 text-xs text-muted">Worked out from how often this happened before. No record states this date.</p>
              )}
            </li>
          );
        })}
      </ul>
      {earlierDateHint && options.length > 1 && (
        <p className="mt-2 text-sm text-ink-2">If you must act before this is settled, plan for the earlier date.</p>
      )}
      {note}
    </>
  );
}

function importance(w: number | null): string {
  return w === 5 ? "blocking" : w === 3 ? "important" : "normal";
}

export function Ladder({
  ws, gaps, traces, viewingRole, roleLabels, names,
}: {
  ws: string;
  gaps: LadderGap[];
  traces: TraceView[];
  viewingRole: string;
  roleLabels: Record<string, string>;
  names: Record<string, string>;
}) {
  const traceById = new Map(traces.map((t) => [t.traceId, t]));
  return (
    <section aria-label="Gaps being worked">
      <h2 className="mb-2 text-xl">Gaps being worked ({gaps.length})</h2>
      <ol className="grid gap-3">
        {gaps.map((g) => (
          <li key={g.questionId} className="card p-4" data-gap={`${g.responsibilityKey}.${g.checkKey}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="max-w-3xl text-ink">
                <span className="mono mr-2 text-muted">{g.rank}.</span>
                {g.text}
              </p>
              <span className="flex flex-wrap gap-1.5">
                <Chip {...STATE[g.state]} />
                <Chip {...GAP[g.gapType]} />
                {g.weight === 5 && <Chip symbol="■" label="Blocking" tone="bad" />}
                {g.urgency !== null && g.urgency > 1 && <Chip symbol="◷" label="Due soon" tone="warn" />}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              <span className="mono">{g.responsibilityKey}</span> {g.responsibilityTitle} · {g.checkLabel} · Why asked:{" "}
              {importance(g.weight)} check (weight {g.weight ?? 0}), {g.gapType}{g.urgency !== null && g.urgency > 1 ? ", due within 14 days" : ""}
            </p>

            <div className="mt-3 grid gap-3 border-t border-rule pt-3">
              <div>
                <h3 className="text-sm font-semibold">1. People who worked on this</h3>
                <p className="mb-1.5 text-xs text-muted">
                  Picked from who replied to whom, who changed the same files and who shared calendar events. No message text
                  was read to pick them.
                </p>
                <People ws={ws} steps={g.rungs[1]} viewingRole={viewingRole} roleLabels={roleLabels} />
              </div>
              <div>
                <h3 className="mb-1.5 text-sm font-semibold">2. What the files and history show</h3>
                <Files ws={ws} steps={g.rungs[2]} traces={traceById} />
              </div>
              <div>
                <h3 className="text-sm font-semibold">3. Possible answers</h3>
                <p className="mb-1.5 text-xs text-muted">Leads, not answers. They never close a gap.</p>
                <Options ws={ws} steps={g.rungs[3]} names={names} earlierDateHint={g.earlierDateHint} />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
