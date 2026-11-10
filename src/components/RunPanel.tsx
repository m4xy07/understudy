"use client";
// Live pipeline progress. Polls GET /api/w/[id]/run every 1.5 s while a run is in progress and
// refreshes the page when it finishes. RunPill is the small header indicator.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import type { RunStatus, RunStep } from "@/lib/db/mappers";

const POLL_MS = 1500;

function useRun(ws: string, initial: RunStatus | null) {
  const router = useRouter();
  const [run, setRun] = useState<RunStatus | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(initial?.status === "running");

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/w/${ws}/run`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { run: RunStatus | null };
      setRun(data.run);
      setError(null);
      if (wasRunning.current && data.run && data.run.status !== "running") router.refresh();
      wasRunning.current = data.run?.status === "running";
    } catch {
      setError("Lost contact with the server. Retrying…");
    }
  }, [ws, router]);

  useEffect(() => {
    if (run?.status !== "running") return;
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [run?.status, poll]);

  const markStarted = useCallback((next: RunStatus | null) => {
    wasRunning.current = true;
    setRun(next);
  }, []);

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
    .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
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
