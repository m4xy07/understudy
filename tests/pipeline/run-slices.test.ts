// The run lease and resumable slices (Round 2 fix b), against the local database with a fake
// model endpoint: two runs can never overlap, a run that needs more than one function invocation
// finishes, a dead slice is continued, a batch that always fails is tried three times and named,
// and neither the slice count nor the model spend is unbounded.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { getRunStatus } from "@/lib/db/queries";
import { createEmptyWorkspace, ingestUpload } from "@/lib/pipeline/ingest";
import { executeRun, MAX_ATTEMPTS, MAX_SLICES, progressText, runToEnd, startRun } from "@/lib/pipeline/run";
import { resetSpendMemo, spendToday } from "@/lib/pipeline/guard";
import { useFakeModel, type FakeModel } from "../helpers/fake-model";

const sql = db();
const made: string[] = [];
let fake: FakeModel;

/** A workspace with `n` Markdown notes: one extraction batch per note. */
async function workspaceWithNotes(n: number, poison = -1): Promise<string> {
  const ws = await createEmptyWorkspace("slices test");
  made.push(ws);
  const files = Array.from({ length: n }, (_, i) => ({
    path: `note-${String(i).padStart(2, "0")}.md`,
    // The workspace id is in the text, so no two workspaces share a prompt (and so a cache key).
    content: `# Note ${i}\n\nIn ${ws} the owner of thing ${i} is person ${i}. ${i === poison ? "POISON" : "Nothing else."}\n`,
  }));
  const res = await ingestUpload(ws, "markdown", files);
  expect(res.ok).toBe(true);
  return ws;
}

async function drafts(ws: string): Promise<string[]> {
  const [row] = await sql`SELECT drafts FROM attest_runs WHERE workspace_id = ${ws}`;
  const list = (typeof row.drafts === "string" ? JSON.parse(row.drafts) : row.drafts) as { value: string; origin: string }[];
  return list.filter((d) => d.origin === "extracted").map((d) => d.value).sort();
}

beforeAll(() => {
  fake = useFakeModel("fake-slices");
  process.env.MODEL_CALLS_PER_WORKSPACE_PER_DAY = "0"; // no cap unless a test sets one
  process.env.MODEL_CALLS_PER_DAY = "0";
});

afterAll(async () => {
  delete process.env.MODEL_CALLS_PER_WORKSPACE_PER_DAY;
  delete process.env.MODEL_CALLS_PER_DAY;
  await fake.cleanup();
  for (const ws of made) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("run lease", () => {
  it("five starts at the same moment make one run; the other four attach to it", async () => {
    const ws = await workspaceWithNotes(1);
    const starts = await Promise.all([1, 2, 3, 4, 5].map(() => startRun(ws)));
    expect(starts.filter((s) => !s.alreadyRunning)).toHaveLength(1);
    expect(new Set(starts.map((s) => s.runId)).size).toBe(1);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM runs WHERE workspace_id = ${ws}`;
    expect(n).toBe(1);
    const run = await executeRun(ws, starts[0].runId);
    expect(run?.status).toBe("done");
    // A finished run does not block the next one.
    const next = await startRun(ws);
    expect(next.alreadyRunning).toBe(false);
    expect(next.runId).not.toBe(starts[0].runId);
    expect((await executeRun(ws, next.runId))?.status).toBe("done");
  });

  it("the database itself refuses a second live run of one workspace", async () => {
    const ws = await workspaceWithNotes(1);
    await sql`INSERT INTO runs (workspace_id, status) VALUES (${ws}, 'running')`;
    await expect(sql`INSERT INTO runs (workspace_id, status) VALUES (${ws}, 'paused')`).rejects.toThrow(/runs_one_live/);
    await sql`UPDATE runs SET status = 'failed' WHERE workspace_id = ${ws}`;
  });

  it("a slice that died is continued by the next start once its lease has expired, not before", async () => {
    const ws = await workspaceWithNotes(2);
    const first = await startRun(ws); // the worker "dies": executeRun is never called
    expect((await startRun(ws)).alreadyRunning).toBe(true); // lease still held
    expect((await getRunStatus(ws))?.resumable).toBe(false);
    await sql`UPDATE runs SET lease_until = now() - interval '1 second' WHERE workspace_id = ${ws} AND id = ${first.runId}`;
    expect((await getRunStatus(ws))?.resumable).toBe(true);
    const again = await startRun(ws);
    expect(again).toMatchObject({ runId: first.runId, alreadyRunning: false, resumed: true });
    const run = await executeRun(ws, again.runId);
    expect(run).toMatchObject({ id: first.runId, status: "done", slices: 2 });
  });
});

describe("resumable slices", () => {
  it("a run with a tiny time budget pauses, continues, and ends with the same drafts as a one-shot run", async () => {
    const whole = await workspaceWithNotes(14);
    fake.delayMs = 0;
    expect((await runToEnd(whole))?.status).toBe("done");
    const expected = await drafts(whole);
    expect(expected).toHaveLength(14);

    const ws = await workspaceWithNotes(14);
    fake.delayMs = 120;
    fake.calls.length = 0;
    const seen: number[] = [];
    let status = null as Awaited<ReturnType<typeof getRunStatus>>;
    let slices = 0;
    for (; slices < 30; slices++) {
      const started = await startRun(ws);
      expect(started.alreadyRunning).toBe(false);
      status = await executeRun(ws, started.runId, { budgetMs: 200 });
      if (status?.progress) seen.push(status.progress.done);
      if (status?.status !== "paused") break;
      expect(status.resumable).toBe(true);
      // The step it stopped in (or before) says so in words.
      expect(status.steps.map((s) => s.note ?? "").join(" ")).toMatch(/Paused (at|before .* at) the time limit of one slice/);
    }
    fake.delayMs = 0;
    expect(status?.status).toBe("done");
    expect(status!.slices).toBeGreaterThan(1); // it really needed more than one invocation
    expect([...seen].sort((a, b) => a - b)).toEqual(seen); // progress never goes down
    expect(await drafts(ws)).toEqual(expected);
    // Each batch was read live exactly once: later slices replay finished batches from the cache.
    const extraction = fake.calls.filter((u) => u.startsWith("Thread: "));
    expect(extraction).toHaveLength(14);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM runs WHERE workspace_id = ${ws}`;
    expect(n).toBe(1); // one run row, however many slices
  }, 120_000);

  it("a batch that always fails is tried three times, then named; the run still ends", async () => {
    const ws = await workspaceWithNotes(4, 2);
    fake.calls.length = 0;
    fake.failWhen = (u) => u.includes("POISON");
    const status = await runToEnd(ws);
    fake.failWhen = () => false;
    expect(status?.status).toBe("done");
    expect(fake.calls.filter((u) => u.includes("POISON"))).toHaveLength(MAX_ATTEMPTS);
    const step = status!.steps.find((s) => s.key === "reconstruct")!;
    expect(step.status).toBe("done");
    expect(step.note).toMatch(/1 of 4 batches failed/);
    expect(await drafts(ws)).toHaveLength(3);
  }, 60_000);

  it("a run stops with a clear message at the slice limit instead of looping", async () => {
    const ws = await workspaceWithNotes(1);
    const { runId } = await startRun(ws);
    await sql`UPDATE runs SET slices = ${MAX_SLICES + 1} WHERE workspace_id = ${ws} AND id = ${runId}`;
    const status = await executeRun(ws, runId);
    expect(status?.status).toBe("failed");
    expect(status?.error).toMatch(/stopped after 40 slices/);
    expect((await startRun(ws)).alreadyRunning).toBe(false); // and it does not block a new run
  });

  it("the per-workspace cap stops live model calls and says so", async () => {
    process.env.MODEL_CALLS_PER_WORKSPACE_PER_DAY = "3";
    resetSpendMemo();
    const ws = await workspaceWithNotes(8);
    fake.calls.length = 0;
    const status = await runToEnd(ws);
    process.env.MODEL_CALLS_PER_WORKSPACE_PER_DAY = "0";
    expect(status?.status).toBe("done");
    expect(fake.calls).toHaveLength(3);
    expect(await spendToday(ws)).toMatchObject({ calls: 3 });
    const step = status!.steps.find((s) => s.key === "reconstruct")!;
    expect(step.note).toMatch(/model budget/i);
    expect(await drafts(ws)).toHaveLength(3);
  }, 60_000);
});

describe("progress text", () => {
  it("names counts in words: done of total, cached, to retry, failed, skipped", () => {
    expect(progressText({ step: "reconstruct", done: 12, total: 40, cached: 9, failed: 0, retry: 1, refused: 0 }))
      .toBe("Read 12 of 40 batches (9 from the cache, 1 will be retried).");
    expect(progressText({ step: "reconstruct", done: 1, total: null, cached: 0, failed: 0, retry: 0, refused: 0 }))
      .toBe("Read 1 batch so far.");
    expect(progressText({ step: "verify", done: 3, total: 5, cached: 0, failed: 2, retry: 0, refused: 0 }))
      .toBe("Read 3 of 5 support checks (2 failed).");
  });
});
