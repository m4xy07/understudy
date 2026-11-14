// "Rebuilt procedures": every trace claim the viewing role may see, with its cited steps.
// A step is marked "Quoted" when Attest found its quote word for word in the cited segment,
// otherwise "Worked out from history". The whole procedure is always labelled Inferred.
import Link from "next/link";
import { TrustChip } from "@/components/chips";
import type { TraceView } from "@/lib/lacuna";

export function TraceSteps({ ws, trace }: { ws: string; trace: TraceView }) {
  return (
    <>
      <ol className="mt-1.5 grid gap-1 text-sm">
        {trace.steps.map((s) => (
          <li key={s.n} className="flex flex-wrap items-baseline gap-x-2">
            <span className="mono text-muted">{s.n}.</span>
            <span className="max-w-3xl">{s.text}</span>
            <span className="text-xs text-muted">{s.kind === "quoted" && s.exact ? "Quoted" : "Worked out from history"}</span>
            {s.segmentId && (
              <Link href={`/w/${ws}/source/${s.segmentId}?claim=${trace.claimId}&cite=${s.cite}`} className="text-xs text-attest underline">
                Open source
              </Link>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-1.5 text-xs text-muted">
        {trace.quoted} of {trace.total} steps are quoted word for word. The order, and what was left out, is our reading, so the
        whole procedure is labelled Inferred.
      </p>
    </>
  );
}

export function RebuiltProcedures({ ws, traces }: { ws: string; traces: TraceView[] }) {
  return (
    <section className="mt-8" aria-label="Rebuilt procedures">
      <h2 className="mb-1 text-xl">Rebuilt procedures ({traces.length})</h2>
      <p className="mb-3 max-w-3xl text-sm text-ink-2">
        Procedures read back from workflow files, the run history, commit history and calendar entries. All are labelled
        Inferred until a person confirms them in Review.
      </p>
      {traces.length === 0 ? (
        <p className="text-sm text-muted">Nothing could be rebuilt from the files and history your role can see.</p>
      ) : (
        <ul className="grid gap-3">
          {traces.map((t) => (
            <li key={t.traceId} className="card p-4" data-trace={t.traceKind}>
              <div className="flex flex-wrap items-center gap-2">
                <TrustChip trust="inferred" />
                <span className="font-medium">{t.title}</span>
                <span className="text-xs text-muted">{t.entityLabel}</span>
              </div>
              <TraceSteps ws={ws} trace={t} />
              <p className="mt-1.5 text-sm text-ink-2">
                {t.helps.length > 0
                  ? `Helps with: ${t.helps.map((h) => `${h.responsibilityKey} ${h.checkLabel}`).join(", ")}`
                  : "No open gap needs this. Kept for the handover."}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
