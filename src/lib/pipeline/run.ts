// Pipeline orchestration: connect -> reconstruct -> verify -> test -> ask.
// Each run is a row in `runs`; every step records status, counts and a note so the UI can
// poll progress. Review and handover are user actions (Relay) and are not part of a run.
import { db } from "@/lib/db/client";
import type { RunStatus, RunStep, RunStepKey } from "@/lib/db/mappers";
import { getRunStatus, listSources, audit } from "@/lib/db/queries";
import { getWorkspacePack, type ResolvedPack } from "@/lib/pack";
import { reconstruct, verify } from "@/lib/attest";
import { buildInventory, buildQuestions, runTest } from "@/lib/lacuna";
import { modelAvailable } from "@/lib/model/client";
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
const STALE_MS = 6 * 60 * 1000; // a "running" run older than this is treated as dead

function freshSteps(): RunStep[] {
  return ORDER.map((key) => ({
    key, label: STEP_LABELS[key], status: "pending", counts: {}, note: null, startedAt: null, finishedAt: null,
  }));
}

/**
 * Create a run row (or return the one already in progress). Call executeRun(ws, id) next,
 * usually inside `after()` so the request returns immediately.
 */
export async function startRun(ws: string): Promise<{ runId: string; alreadyRunning: boolean }> {
  const current = await getRunStatus(ws);
  if (current && current.status === "running" && Date.now() - Date.parse(current.startedAt) < STALE_MS) {
    return { runId: current.id, alreadyRunning: true };
  }
  const [row] = await db()`
    INSERT INTO runs (workspace_id, status, steps) VALUES (${ws}, 'running', ${JSON.stringify(freshSteps())}::jsonb)
    RETURNING id`;
  return { runId: String(row.id), alreadyRunning: false };
}

async function saveSteps(ws: string, runId: string, steps: RunStep[]): Promise<void> {
  await db()`UPDATE runs SET steps = ${JSON.stringify(steps)}::jsonb WHERE workspace_id = ${ws} AND id = ${runId}`;
}

type StepFn = () => Promise<{ counts: Record<string, number>; note?: string | null }>;

/** Run every step in order. Never throws: failures are recorded on the step and the run. */
export async function executeRun(ws: string, runId: string): Promise<RunStatus | null> {
  const steps = freshSteps();
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
      return {
        counts: { created: r.claims, total: r.total },
        note: [r.modelNote, up ? null : "Model unavailable: structured sources only."].filter(Boolean).join(" ") || null,
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

  for (const step of steps) {
    if (!pack && step.key !== "connect") {
      step.status = "skipped";
      step.note = "Setting pack unavailable.";
      continue;
    }
    step.status = "running";
    step.startedAt = new Date().toISOString();
    await saveSteps(ws, runId, steps).catch(() => {});
    try {
      const res = await fns[step.key]();
      step.counts = res.counts;
      step.note = res.note ?? null;
      step.status = "done";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      step.status = "failed";
      step.note = msg.slice(0, 300);
      errors.push(`${step.label}: ${msg}`);
      console.error(`[pipeline ${ws}] ${step.key} failed`, err);
    }
    step.finishedAt = new Date().toISOString();
    await saveSteps(ws, runId, steps).catch(() => {});
  }

  const status = errors.length ? "failed" : "done";
  try {
    await db()`
      UPDATE runs SET status = ${status}, error = ${errors.join("\n").slice(0, 2000) || null}, finished_at = now(),
        steps = ${JSON.stringify(steps)}::jsonb
      WHERE workspace_id = ${ws} AND id = ${runId}`;
    await audit(ws, "system", "pipeline_run", { runId, status });
  } catch (err) {
    console.error(`[pipeline ${ws}] could not record run end`, err);
  }
  return getRunStatus(ws).catch(() => null);
}
