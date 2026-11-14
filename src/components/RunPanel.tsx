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

const isLive = (r: RunStatus | null | undefined) => r?.status === "running" || r?.status === "paused";

// One "continue" request per run slice, shared by RunPanel and RunPill (the server's run lease is
// the real guard; this only avoids sending the same request twice from one page).
const resumeAsked = new Map<string, number>();
const RESUME_GAP_MS = 5000;

function useRun(ws: string, initial: RunStatus | null, initialBackground = false) {
  const router = useRouter();
  const [run, setRun] = useState<RunStatus | null>(initial);
  const [background, setBackground] = useState(initialBackground);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const wasRunning = useRef(isLive(initial));
  const wasBackground = useRef(initialBackground);
  // Keep the router in a ref so the polling callbacks stay stable and the interval is not reset.
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  // A server refresh (after an action) can report background work that started since this mounted.
  const [seenBackground, setSeenBackground] = useState(initialBackground);
  if (initialBackground !== seenBackground) {
    setSeenBackground(initialBackground);
    if (initialBackground) setBackground(true);
  }
  useEffect(() => {
    if (background) wasBackground.current = true;
  }, [background]);

  const finished = useCallback((next: RunStatus | null) => {
    const key = next?.id ?? `${ws}:none`;
    if (refreshedRuns.has(key)) return;
    refreshedRuns.add(key);
    routerRef.current.refresh();
  }, [ws]);

  /** A paused run, or one whose worker died, continues when asked: same run, next slice. */
  const resume = useCallback(async (r: RunStatus) => {
    const key = `${r.id}:${r.slices}`;
    const last = resumeAsked.get(key) ?? 0;
    if (Date.now() - last < RESUME_GAP_MS) return;
    resumeAsked.set(key, Date.now());
    try {
      await fetch(`/api/w/${ws}/run`, { method: "POST" });
    } catch {
      // the next poll asks again
    }
  }, [ws]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/w/${ws}/run`, { cache: "no-store" });
      if (res.status === 404) {
        setGone(true);
        setError("This workspace no longer exists. Start again from the home page.");
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { run: RunStatus | null; background?: boolean };
      setRun(data.run);
      setError(null);
      const stillRunning = isLive(data.run);
      if (wasRunning.current && !stillRunning) finished(data.run);
      wasRunning.current = stillRunning;
      if (data.run && stillRunning && data.run.resumable) void resume(data.run);
      const bg = data.background === true;
      if (wasBackground.current && !bg) routerRef.current.refresh(); // the model re-check landed
      wasBackground.current = bg;
      setBackground(bg);
    } catch {
      setError("Lost contact with the server. Retrying…");
    }
  }, [ws, finished, resume]);

  const live = isLive(run);
  useEffect(() => {
    if (gone || (!live && !background)) return; // done or failed, nothing in the background: no polling
    const first = setTimeout(poll, 0); // check at once: a demo replay can finish before the first interval
    const t = setInterval(poll, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [live, background, gone, poll]);

  const markStarted = useCallback((next: RunStatus | null) => {
    if (next && !isLive(next)) {
      // Finished before we looked: nothing to poll, just bring the page up to date.
      wasRunning.current = false;
      setRun(next);
      finished(next);
      return;
    }
    wasRunning.current = true;
    setRun(next);
  }, [finished]);

  return { run, background, error, setError, poll, markStarted };
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

function progressLine(p: NonNullable<RunStatus["progress"]>): string {
  const lead = p.total && p.total > 0
    ? `${p.done} of ${p.total} model ${p.total === 1 ? "call" : "calls"} finished`
    : `${p.done} model ${p.done === 1 ? "call" : "calls"} finished so far`;
  const parts = [
    p.cached ? `${p.cached} from the cache` : null,
    p.retry ? `${p.retry} will be retried` : null,
    p.failed ? `${p.failed} failed` : null,
    p.refused ? `${p.refused} skipped because today's model budget is used` : null,
  ].filter(Boolean);
  return parts.length ? `${lead} (${parts.join(", ")}).` : `${lead}.`;
}

function countsText(c: Record<string, number>): string {
  return Object.entries(c)
    .map(([k, v]) => `${k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)} ${v}`)
    .join(" · ");
}

export function RunPanel({ ws, initial, hasSources }: { ws: string; initial: RunStatus | null; hasSources: boolean }) {
  const { run, error, setError, markStarted } = useRun(ws, initial);
  const [starting, setStarting] = useState(false);
  const running = isLive(run);
  const [attached, setAttached] = useState(false);
  const busy = useRef(false);

  async function start() {
    if (busy.current) return; // a second click before the first request left
    busy.current = true;
    setStarting(true);
    setError(null);
    setAttached(false);
    try {
      const res = await fetch(`/api/w/${ws}/run`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; alreadyRunning?: boolean };
      if (!res.ok) throw new Error(body.error ?? `the server answered ${res.status}`);
      setAttached(body.alreadyRunning === true);
      const s = await fetch(`/api/w/${ws}/run`, { cache: "no-store" }).then((r) => r.json());
      markStarted(s.run);
    } catch (err) {
      setError(`Could not start the run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.current = false;
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
      {running && attached && (
        <p className="mt-3 text-sm text-muted" role="status">
          A run was already in progress for this workspace (another tab, or an earlier click). This page is following it; no second run was started.
        </p>
      )}
      {running && run?.progress && (
        <div className="mt-3 text-sm" role="status">
          <progress
            className="h-2 w-full"
            aria-label="Model calls finished in this step"
            max={run.progress.total && run.progress.total > 0 ? run.progress.total : undefined}
            value={run.progress.total && run.progress.total > 0 ? Math.min(run.progress.done, run.progress.total) : undefined}
          />
          <p className="mt-1 text-muted">
            {progressLine(run.progress)}
            {run.status === "paused" || run.slices > 1 ? ` Part ${run.slices} of this run: a long upload is read in parts and continues by itself while this page is open.` : ""}
          </p>
        </div>
      )}
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
      {run && !running && (
        <p className={clsx("mt-3 text-sm", run.status === "failed" ? "text-bad" : "text-ok")} role="status">
          {run.status === "failed"
            ? "The run finished with errors. Failed steps are listed above; other steps still ran."
            : "Run finished. Open Reconstruct to see the claims."}
        </p>
      )}
    </section>
  );
}

export function RunPill({ ws, initial, background: initialBackground = false }: { ws: string; initial: RunStatus | null; background?: boolean }) {
  const { run, background } = useRun(ws, initial, initialBackground);
  if (!run || !isLive(run)) {
    if (!background) return null;
    return (
      <span role="status" className="inline-flex items-center gap-1.5 rounded-full border border-attest/40 bg-[#e7edf4] px-2.5 py-0.5 text-xs font-medium text-attest">
        <span aria-hidden="true" className="inline-block animate-spin">◌</span>
        Model re-check running · scores update by themselves
      </span>
    );
  }
  const done = run.steps.filter((s) => s.status === "done" || s.status === "failed" || s.status === "skipped").length;
  return (
    <span role="status" className="inline-flex items-center gap-1.5 rounded-full border border-attest/40 bg-[#e7edf4] px-2.5 py-0.5 text-xs font-medium text-attest">
      <span aria-hidden="true" className="inline-block animate-spin">◌</span>
      Pipeline running · {done}/{run.steps.length}
    </span>
  );
}
