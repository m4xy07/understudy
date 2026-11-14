// Pipeline orchestration: connect -> reconstruct -> verify -> test -> ask.
// Each run is a row in `runs`; every step records status, counts and a note so the UI can
// poll progress. Review and handover are user actions (Relay) and are not part of a run.
//
// One run at a time per workspace, in slices:
//   * startRun takes a lease in one atomic statement. A second caller (double click, second tab,
//     a second request in the same millisecond) attaches to the run in progress.
//   * executeRun is one slice: one function invocation with a time budget. Finished model calls
//     are checkpoints (the model cache), so a later slice replays them at once and carries on.
//     A slice that runs out of time ends "paused"; a slice whose function died stops renewing its
//     lease. In both cases the next POST continues the same run (the run panel sends it).
import { db } from "@/lib/db/client";
import type { RunProgress, RunStatus, RunStep, RunStepKey } from "@/lib/db/mappers";
import { getRunStatus, listSources, audit } from "@/lib/db/queries";
import { getWorkspacePack, type ResolvedPack } from "@/lib/pack";
import { reconstruct, verify } from "@/lib/attest";
import { buildInventory, buildQuestions, runTest } from "@/lib/lacuna";
import { modelAvailable, runWithModelContext, type ModelContext } from "@/lib/model/client";
import { chargeModelCall } from "./guard";
import { reclassify } from "@/lib/tether/visibility";
import type { RoleKey } from "@/lib/types";

export const STEP_LABELS: Record<RunStepKey, string> = {
  connect: "Connect sources",
  reconstruct: "Reconstruct claims",
  verify: "Verify citations",
  test: "Test the successor",
  ask: "Build gap questions",
};

const ORDER: RunStepKey[] = ["connect", "reconstruct", "verify", "test", "ask"];

function envMs(name: string, fallback: number): number {
  const n = Number((process.env[name] ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** No new live model call starts after this much of a slice. Calls in flight may finish (120 s). */
export const SLICE_BUDGET_MS = 150_000;
/** A slice renews its lease this often; a lease not renewed for LEASE_MS belongs to a dead worker. */
export const HEARTBEAT_MS = 10_000;
export const LEASE_MS = 45_000;
/** A run never uses more function invocations than this. */
export const MAX_SLICES = 40;
/** A model call that fails for a passing reason is tried again in a later pass, this many times in all. */
export const MAX_ATTEMPTS = 3;
/** A queued re-run starts in the slice that ended the run before it only with this much time left. */
const MIN_FOLLOW_UP_MS = 5_000;
const PROGRESS_SAVE_MS = 1_200;
const RETRY_PASS_BASE_MS = 1_500;
const RETRY_PASS_MAX_MS = 8_000;

function freshSteps(): RunStep[] {
  return ORDER.map((key) => ({
    key, label: STEP_LABELS[key], status: "pending", counts: {}, note: null, startedAt: null, finishedAt: null,
  }));
}

export interface StartedRun {
  runId: string;
  /** True when a slice of this run is already working: the caller attaches and must not execute. */
  alreadyRunning: boolean;
  /** True when this call continues a paused or abandoned run rather than starting a new one. */
  resumed: boolean;
}

/**
 * Start a run, continue the live one, or attach to it. Call executeRun(ws, runId) next unless
 * `alreadyRunning`, usually inside `after()` so the request returns immediately.
 * Atomic: of any number of concurrent callers exactly one gets alreadyRunning = false.
 */
export async function startRun(ws: string): Promise<StartedRun> {
  const sql = db();
  const lease = LEASE_MS / 1000;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Continue the live run if nobody holds its lease (paused, or its worker died).
    const taken = await sql`
      UPDATE runs SET status = 'running', lease_until = now() + make_interval(secs => ${lease}), heartbeat_at = now(),
        slices = slices + 1
      WHERE workspace_id = ${ws} AND status IN ('running', 'paused') AND (lease_until IS NULL OR lease_until < now())
      RETURNING id`;
    if (taken.length) return { runId: String(taken[0].id), alreadyRunning: false, resumed: true };
    const live = await sql`SELECT id FROM runs WHERE workspace_id = ${ws} AND status IN ('running', 'paused') LIMIT 1`;
    if (live.length) return { runId: String(live[0].id), alreadyRunning: true, resumed: false };
    // No live run: create one. The unique index lets only one of two concurrent inserts through.
    const made = await sql`
      INSERT INTO runs (workspace_id, status, steps, lease_until, heartbeat_at, slices)
      VALUES (${ws}, 'running', ${JSON.stringify(freshSteps())}::jsonb, now() + make_interval(secs => ${lease}), now(), 1)
      ON CONFLICT (workspace_id) WHERE status IN ('running', 'paused') DO NOTHING
      RETURNING id`;
    if (made.length) return { runId: String(made[0].id), alreadyRunning: false, resumed: false };
  }
  const [row] = await sql`SELECT id FROM runs WHERE workspace_id = ${ws} ORDER BY started_at DESC LIMIT 1`;
  if (!row) throw new Error("Could not start a run. Try again.");
  return { runId: String(row.id), alreadyRunning: true, resumed: false };
}

export interface RequestedRerun extends StartedRun {
  /**
   * True when a run was already live (in progress, or paused part-way): the change that asked for
   * this re-run is not in the steps that run has finished, so a full run is queued to start when
   * the live one ends.
   */
  queued: boolean;
}

/**
 * Ask for a run that is guaranteed to start after this moment (a visibility change, say). With
 * no live run this is startRun. With a live run the run is marked: when it ends, executeRun starts
 * one more full run. The caller executes only when `alreadyRunning` is false, as with startRun.
 * Safe against the live run ending at the same moment: the mark and the run's last write lock the
 * same row, so either the run sees the mark or this call starts the next run itself.
 */
export async function requestRerun(ws: string): Promise<RequestedRerun> {
  const sql = db();
  let started = await startRun(ws);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!started.alreadyRunning && !started.resumed) return { ...started, queued: false };
    const marked = await sql`
      UPDATE runs SET cursor = (coalesce(cursor, '{}'::jsonb) #>> '{}')::jsonb || '{"rerun": true}'::jsonb
      WHERE workspace_id = ${ws} AND id = ${started.runId} AND status IN ('running', 'paused')
      RETURNING id`;
    if (marked.length) return { ...started, queued: true };
    // The live run ended between the two statements: start the next one ourselves.
    started = await startRun(ws);
  }
  return { ...started, queued: false };
}

interface Cursor {
  progress?: RunProgress | null;
  /** Failed tries per model call (cache key), kept across slices. */
  attempts?: Record<string, number>;
  /** Highest number of model calls seen in one pass of a step: the step's total. */
  totals?: Partial<Record<RunStepKey, number>>;
}

const UNIT: Partial<Record<RunStepKey, [string, string]>> = {
  reconstruct: ["batch", "batches"],
  verify: ["support check", "support checks"],
  test: ["stand-in answer", "stand-in answers"],
};

/** "Read 12 of 40 batches (9 from the cache, 1 will be retried)." Counts and words, never colour alone. */
export function progressText(p: RunProgress): string {
  const [one, many] = UNIT[p.step] ?? ["model call", "model calls"];
  const unit = (n: number) => (n === 1 ? one : many);
  const lead = p.total !== null && p.total > 0
    ? `Read ${p.done} of ${p.total} ${unit(p.total)}`
    : `Read ${p.done} ${unit(p.done)} so far`;
  const parts = [
    p.cached ? `${p.cached} from the cache` : null,
    p.retry ? `${p.retry} will be retried` : null,
    p.failed ? `${p.failed} failed` : null,
    p.refused ? `${p.refused} skipped: today's model budget is used` : null,
  ].filter(Boolean);
  return parts.length ? `${lead} (${parts.join(", ")}).` : `${lead}.`;
}

type StepFn = () => Promise<{ counts: Record<string, number>; note?: string | null }>;

export interface ExecuteOptions {
  /** Time budget of this slice for starting live model calls (default SLICE_BUDGET_MS). */
  budgetMs?: number;
  /** Retries inside one model call (default 0: a web slice retries across passes instead). */
  retries?: number;
  /** Do not count live calls against the spend cap (scripts run by the team, never a web request). */
  unmetered?: boolean;
}

/** For scripts (precompute, replay check): one long slice, in-call retries, no spend cap. */
export const SCRIPT_RUN: ExecuteOptions = { budgetMs: 60 * 60_000, retries: 3, unmetered: true };

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/**
 * Run one slice: every step that is not finished yet, in order, until the run is done or the time
 * budget is used. Never throws: failures are recorded on the step and the run. Returns the run
 * status ("paused" when another slice is needed).
 */
export async function executeRun(ws: string, runId: string, opts: ExecuteOptions = {}): Promise<RunStatus | null> {
  const sql = db();
  const deadline = Date.now() + (opts.budgetMs ?? envMs("RUN_SLICE_BUDGET_MS", SLICE_BUDGET_MS));
  let steps = freshSteps();
  let cursor: Cursor = {};
  let slices = 1;
  try {
    const [row] = await sql`SELECT steps, cursor, slices, status FROM runs WHERE workspace_id = ${ws} AND id = ${runId}`;
    if (!row || row.status !== "running") return getRunStatus(ws).catch(() => null);
    const stored = parseJson<RunStep[]>(row.steps, []);
    if (Array.isArray(stored) && stored.length === ORDER.length && stored.every((s, i) => s?.key === ORDER[i])) steps = stored;
    cursor = parseJson<Cursor>(row.cursor, {}) ?? {};
    slices = Number(row.slices ?? 1);
  } catch (err) {
    console.error(`[pipeline ${ws}] could not load run ${runId}`, err);
  }
  const attempts: Record<string, number> = { ...(cursor.attempts ?? {}) };
  const totals: Partial<Record<RunStepKey, number>> = { ...(cursor.totals ?? {}) };
  let progress: RunProgress | null = null;

  const save = async (extra: { status?: RunStatus["status"]; error?: string | null; release?: boolean } = {}) => {
    const cur: Cursor = { progress, attempts, totals };
    const status = extra.status ?? "running";
    const ended = status === "done" || status === "failed";
    const rows = await sql`
      UPDATE runs SET steps = ${JSON.stringify(steps)}::jsonb,
        cursor = (${JSON.stringify(cur)}::jsonb #>> '{}')::jsonb
          || jsonb_strip_nulls(jsonb_build_object('rerun', (coalesce(cursor, '{}'::jsonb) #>> '{}')::jsonb -> 'rerun')),
        heartbeat_at = now(),
        status = ${status},
        lease_until = CASE WHEN ${extra.release === true || ended} THEN NULL ELSE now() + make_interval(secs => ${LEASE_MS / 1000}) END,
        error = ${extra.error ?? null},
        finished_at = CASE WHEN ${ended} THEN now() ELSE NULL END
      WHERE workspace_id = ${ws} AND id = ${runId} AND status = 'running'
      RETURNING (cursor -> 'rerun')::text AS rerun`;
    return rows.length > 0 && rows[0].rerun === "true";
  };
  const heartbeat = setInterval(() => {
    save().catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const errors: string[] = [];
  let pack: ResolvedPack | null = null;
  try {
    pack = await getWorkspacePack(ws);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  // The successor, then every role the pack flags as restricted audience.
  const roles: RoleKey[] = pack ? pack.testRoles : [];

  const fns: Record<RunStepKey, StepFn> = {
    connect: async () => {
      // Segments an older rules version stored are looked at again; newly sensitive ones are limited.
      await reclassify(ws);
      const sources = await listSources(ws);
      const segments = sources.reduce((n, s) => n + s.segmentCount, 0);
      return {
        counts: { sources: sources.length, segments },
        note: sources.length ? null : "No sources yet. Upload a file or open the demo.",
      };
    },
    reconstruct: async () => {
      const up = await modelAvailable();
      const r = await reconstruct(ws);
      const said = /model unavailable/i.test(r.modelNote ?? "");
      return {
        counts: { created: r.claims, total: r.total },
        note: [r.modelNote, up || said ? null : "Model unavailable: structured sources only."].filter(Boolean).join(" ") || null,
      };
    },
    verify: async () => {
      const v = await verify(ws);
      return { counts: { ...v } };
    },
    test: async () => {
      const inv = await buildInventory(ws);
      const counts: Record<string, number> = { responsibilities: inv.responsibilities };
      for (const role of roles) {
        const t = await runTest(ws, role);
        counts[`B_${role}`] = t.scores.b;
        counts[`C_${role}`] = Math.round(t.scores.c * 100);
      }
      return { counts };
    },
    ask: async () => {
      const qs = await buildQuestions(ws);
      return { counts: { questions: qs.filter((q) => !q.answeredClaimId).length } };
    },
  };

  let paused: string | null = null;
  try {
    const overLimit = slices > MAX_SLICES;
    if (overLimit) {
      errors.push(`The run was stopped after ${MAX_SLICES} slices. What was read so far is kept; press Run again to continue.`);
      for (const s of steps) {
        if (s.status === "running" || s.status === "pending") {
          s.status = "skipped";
          s.note = "Not finished: the run reached its slice limit.";
        }
      }
    }
    let ranOne = false;
    for (const step of steps) {
      if (overLimit) break;
      if (step.status === "done" || step.status === "failed" || step.status === "skipped") continue;
      if (!pack && step.key !== "connect") {
        step.status = "skipped";
        step.note = "Setting pack unavailable.";
        continue;
      }
      // Out of time before this step even starts: leave it for the next slice.
      if (ranOne && Date.now() >= deadline) {
        paused = `Paused before "${step.label}" at the time limit of one slice: it continues by itself.`;
        step.note = paused;
        break;
      }
      ranOne = true;
      step.status = "running";
      step.startedAt = step.startedAt ?? new Date().toISOString();
      await save().catch(() => {});

      // One pass over the step, repeated while calls that failed for a passing reason remain and
      // time is left. Finished calls replay from the cache, so a pass only redoes what is missing.
      for (let pass = 0; ; pass++) {
        const p: RunProgress = { step: step.key, done: 0, total: totals[step.key] ?? null, cached: 0, failed: 0, retry: 0, refused: 0 };
        progress = p;
        let deferred = 0;
        let seen = 0;
        let lastSave = 0;
        const ctx: ModelContext = {
          deadline,
          retries: opts.retries ?? 0,
          gate: async (key) => {
            if ((attempts[key] ?? 0) >= MAX_ATTEMPTS) return `this call failed ${MAX_ATTEMPTS} times and was not tried again`;
            return opts.unmetered ? null : chargeModelCall(ws);
          },
          onResult: (key, outcome, info) => {
            seen++;
            if (outcome === "cached" || outcome === "live") {
              p.done++;
              if (outcome === "cached") p.cached++;
            } else if (outcome === "deferred") {
              deferred++;
            } else if (outcome === "refused") {
              if ((attempts[key] ?? 0) >= MAX_ATTEMPTS) p.failed++;
              else p.refused++;
            } else if (info.transient) {
              attempts[key] = (attempts[key] ?? 0) + 1;
              if (attempts[key] >= MAX_ATTEMPTS) p.failed++;
              else p.retry++;
            } else {
              p.failed++;
            }
            if (Date.now() - lastSave > PROGRESS_SAVE_MS) {
              lastSave = Date.now();
              if (seen > 1) step.note = progressText(p);
              save().catch(() => {});
            }
          },
        };
        let failedHard = false;
        try {
          const res = await runWithModelContext(ctx, fns[step.key]);
          step.counts = res.counts;
          step.note = res.note ?? null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          step.status = "failed";
          step.note = msg.slice(0, 300);
          errors.push(`${step.label}: ${msg}`);
          console.error(`[pipeline ${ws}] ${step.key} failed`, err);
          failedHard = true;
        }
        if (seen > (totals[step.key] ?? 0)) totals[step.key] = seen;
        p.total = totals[step.key] ?? null;
        if (failedHard) break;
        if (!deferred && !p.retry) {
          if (p.refused || p.failed) step.note = [step.note, p.refused ? progressText(p) : null].filter(Boolean).join(" ") || null;
          step.status = "done";
          break;
        }
        if (deferred || Date.now() >= deadline) {
          paused = `${progressText(p)} Paused at the time limit of one slice: it continues by itself.`;
          step.note = paused;
          break;
        }
        step.note = `${progressText(p)} Retrying.`;
        await save().catch(() => {});
        // Back off before the next pass (1.5 s, 3 s, 6 s): a rate limit needs a moment to clear.
        await new Promise((r) => setTimeout(r, Math.min(RETRY_PASS_MAX_MS, RETRY_PASS_BASE_MS * 2 ** pass)));
      }
      if (paused) break;
      step.finishedAt = new Date().toISOString();
      progress = null;
      await save().catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
  }

  if (paused) {
    try {
      await save({ status: "paused", release: true });
    } catch (err) {
      console.error(`[pipeline ${ws}] could not record the pause`, err);
    }
    return getRunStatus(ws).catch(() => null);
  }

  const status = errors.length ? "failed" : "done";
  progress = null;
  let rerun = false;
  try {
    rerun = await save({ status, error: errors.join("\n").slice(0, 2000) || null });
    await audit(ws, "system", "pipeline_run", { runId, status, slices });
  } catch (err) {
    console.error(`[pipeline ${ws}] could not record run end`, err);
  }
  // Something changed while this run worked (requestRerun): one more full run, so the change is
  // applied. It starts in this slice when time is left; otherwise it waits, paused, for the next
  // POST (the run panel sends it by itself).
  if (rerun) {
    try {
      const next = await startRun(ws);
      if (!next.alreadyRunning) {
        await audit(ws, "system", "pipeline_rerun_queued", { after: runId, runId: next.runId });
        const left = deadline - Date.now();
        if (left > MIN_FOLLOW_UP_MS) return executeRun(ws, next.runId, { ...opts, budgetMs: left });
        await sql`
          UPDATE runs SET status = 'paused', lease_until = NULL
          WHERE workspace_id = ${ws} AND id = ${next.runId} AND status = 'running'`;
      }
    } catch (err) {
      console.error(`[pipeline ${ws}] could not start the queued re-run`, err);
    }
  }
  return getRunStatus(ws).catch(() => null);
}

/**
 * Start or continue a run and execute slices until it ends (scripts and tests; a web request runs
 * one slice per invocation and lets the run panel ask for the next).
 */
export async function runToEnd(ws: string, opts: ExecuteOptions = {}): Promise<RunStatus | null> {
  let status: RunStatus | null = null;
  for (let i = 0; i <= MAX_SLICES + 1; i++) {
    const started = await startRun(ws);
    if (started.alreadyRunning) return getRunStatus(ws);
    status = await executeRun(ws, started.runId, opts);
    if (!status || status.status !== "paused") return status;
  }
  return status;
}
