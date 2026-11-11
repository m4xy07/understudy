"use client";
// Live pipeline progress. Polls GET /api/w/[id]/run every 1.5 s while a run is in progress and,
// when it finishes, refreshes the server parts of the page (the header stepper, counts, claims)
// so nobody has to reload. Polling stops once the run is done or failed. RunPill is the small
// header indicator; RunPanel is the full list on Connect.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import type { RunStatus, RunStep } from "@/lib/db/mappers";

const POLL_MS = 1500;

// RunPanel and RunPill both watch the same run: refresh once per finished run, not once per hook.
const refreshedRuns = new Set<string>();

function useRun(ws: string, initial: RunStatus | null) {
  const router = useRouter();
  const [run, setRun] = useState<RunStatus | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(initial?.status === "running");
  // Keep the router in a ref so the polling callbacks stay stable and the interval is not reset.
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  const finished = useCallback((next: RunStatus | null) => {
    const key = next?.id ?? `${ws}:none`;
    if (refreshedRuns.has(key)) return;
    refreshedRuns.add(key);
    routerRef.current.refresh();
  }, [ws]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/w/${ws}/run`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { run: RunStatus | null };
      setRun(data.run);
      setError(null);
      const stillRunning = data.run?.status === "running";
      if (wasRunning.current && !stillRunning) finished(data.run);
      wasRunning.current = stillRunning;
    } catch {
      setError("Lost contact with the server. Retrying…");
    }
  }, [ws, finished]);

  useEffect(() => {
    if (run?.status !== "running") return; // done or failed: no more polling
    const first = setTimeout(poll, 0); // check at once: a demo replay can finish before the first interval
    const t = setInterval(poll, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [run?.status, poll]);

  const markStarted = useCallback((next: RunStatus | null) => {
    if (next && next.status !== "running") {
      // Finished before we looked: nothing to poll, just bring the page up to date.
      wasRunning.current = false;
      setRun(next);
      finished(next);
      return;
    }
    wasRunning.current = true;
    setRun(next);
  }, [finished]);

  return { run, error, setError, poll, markStarted };
}

function stepSymbol(s: RunStep): { symbol: string; word: string; cls: string } {
  switch (s.status) {
    case "done":
      return { symbol: "✓", word: "Done", cls: "text-ok" };
    case "running":
      return { symbol: "◌", word: "Running", cls: "text-attest" };
    case "failed":
      return { symbol: "✕", word: "Failed", cls: "text-bad" };
    case "skipped":
      return { symbol: "–", word: "Skipped", cls: "text-muted" };
    default:
      return { symbol: "○", word: "Waiting", cls: "text-muted" };
  }
}

function countsText(c: Record<string, number>): string {
  return Object.entries(c)
    .map(([k, v]) => `${k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)} ${v}`)
    .join(" · ");
}

export function RunPanel({ ws, initial, hasSources }: { ws: string; initial: RunStatus | null; hasSources: boolean }) {
  const { run, error, setError, markStarted } = useRun(ws, initial);
  const [starting, setStarting] = useState(false);
  const running = run?.status === "running";

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`/api/w/${ws}/run`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `status ${res.status}`);
      const s = await fetch(`/api/w/${ws}/run`, { cache: "no-store" }).then((r) => r.json());
      markStarted(s.run);
    } catch (err) {
      setError(`Could not start the run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <section aria-labelledby="run-h" className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="run-h" className="text-xl">Run Understudy</h2>
          <p className="text-sm text-muted">Reconstruct claims, verify citations, test the successor, build gap questions.</p>
        </div>
        <button type="button" className="btn" onClick={start} disabled={running || starting || !hasSources} aria-busy={running || starting}>
          {running ? "Running…" : starting ? "Starting…" : run ? "Run again" : "Run Understudy"}
        </button>
      </div>
      {!hasSources && <p className="mt-3 text-sm text-muted">Add at least one source first.</p>}
      {running && (
        <p className="mt-3 text-sm text-muted" role="status">
          The demo replays precomputed model answers and finishes in a few seconds. Your own uploads call the model live and can take a few minutes. The steps below update by themselves; you can stay on this page.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          <span aria-hidden="true">✕ </span>
          {error}
        </p>
      )}
      {run && (
        <ol className="mt-4 grid gap-2" aria-live="polite">
          {run.steps.map((s) => {
            const st = stepSymbol(s);
            return (
              <li key={s.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-rule pt-2 text-sm">
                <span className={clsx("w-24 flex-none font-medium", st.cls)}>
                  <span aria-hidden="true" className={clsx(s.status === "running" && "inline-block animate-spin")}>
                    {st.symbol}
                  </span>{" "}
                  {st.word}
                </span>
                <span className="font-medium text-ink">{s.label}</span>
                {Object.keys(s.counts).length > 0 && <span className="mono text-muted">{countsText(s.counts)}</span>}
                {s.note && <span className={clsx("basis-full pl-[6.75rem] text-xs", s.status === "failed" ? "text-bad" : "text-muted")}>{s.note}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {run && run.status !== "running" && (
        <p className={clsx("mt-3 text-sm", run.status === "failed" ? "text-bad" : "text-ok")} role="status">
          {run.status === "failed"
            ? "The run finished with errors. Failed steps are listed above; other steps still ran."
            : "Run finished. Open Reconstruct to see the claims."}
        </p>
      )}
    </section>
  );
}

export function RunPill({ ws, initial }: { ws: string; initial: RunStatus | null }) {
  const { run } = useRun(ws, initial);
  if (!run || run.status !== "running") return null;
  const done = run.steps.filter((s) => s.status === "done" || s.status === "failed" || s.status === "skipped").length;
  return (
    <span role="status" className="inline-flex items-center gap-1.5 rounded-full border border-attest/40 bg-[#e7edf4] px-2.5 py-0.5 text-xs font-medium text-attest">
      <span aria-hidden="true" className="inline-block animate-spin">◌</span>
      Pipeline running · {done}/{run.steps.length}
    </span>
  );
}
