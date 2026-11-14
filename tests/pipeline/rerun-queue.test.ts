// A visibility change while a run is in progress (review finding 1): the change must not execute
// a second slice on the live run. It queues one full run behind it, and that run really happens.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { createEmptyWorkspace, ingestSources } from "@/lib/pipeline/ingest";
import { executeRun, requestRerun, startRun } from "@/lib/pipeline/run";
import { setSegmentVisibility, visibilityMessage } from "@/lib/tether/visibility";
import type { RoleKey } from "@/lib/types";
import { CLUB, CLUB_ID } from "../helpers/club";

const sql = db();
const made: string[] = [];
const ALL: RoleKey[] = [...CLUB.roleOrder];
const APPROVER = CLUB.approverRole;
const CHAT = [
  "01/11/26, 10:00 - Ananya Iyer: Priya paid Rs 450 for the lab booking deposit, I will reimburse her on Monday.",
  "01/11/26, 10:05 - Rohan Mehta: Build day is Saturday at 5 pm in Lab 3.",
].join("\n");

async function fixture(): Promise<{ ws: string; deposit: string; build: string }> {
  const ws = await createEmptyWorkspace("rerun queue fixture", CLUB_ID);
  made.push(ws);
  await ingestSources(ws, [
    { kind: "whatsapp", name: "Core chat", roleSet: ALL, files: [{ path: "Core chat.txt", content: CHAT }] },
  ], "upload", { sensitivityCall: null });
  const segs = await sql`SELECT id, text FROM segments WHERE workspace_id = ${ws}`;
  const of = (needle: string) => String(segs.find((s) => String(s.text).includes(needle))!.id);
  return { ws, deposit: of("Rs 450"), build: of("Build day") };
}

const runs = (ws: string) => sql`SELECT id, status, cursor, slices FROM runs WHERE workspace_id = ${ws} ORDER BY started_at, id`;

beforeAll(() => {
  process.env.MODEL_CALLS_PER_WORKSPACE_PER_DAY = "0";
  process.env.MODEL_CALLS_PER_DAY = "0";
});

afterAll(async () => {
  delete process.env.MODEL_CALLS_PER_WORKSPACE_PER_DAY;
  delete process.env.MODEL_CALLS_PER_DAY;
  for (const ws of made) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("a visibility change while a run is in progress", () => {
  it("does not hand the caller the live run to execute; it queues one full run behind it", async () => {
    const { ws, build } = await fixture();
    const live = await startRun(ws); // a slice of this run is working (its lease is held)
    expect(live.alreadyRunning).toBe(false);

    const res = await setSegmentVisibility(ws, build, { action: "limit", categories: ["hr"], reason: "A remark about a member's work." }, APPROVER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    // The bug: runId was the live run and the action executed it a second time.
    expect(res.runId).toBeNull();
    expect(res.queued).toBe(true);
    expect(visibilityMessage("Limited", res)).toMatch(/applies at the next run/);

    let rows = await runs(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0].slices).toBe(1); // no second slice was taken
    expect((rows[0].cursor as { rerun?: boolean }).rerun).toBe(true);

    // The live slice finishes: the queued run starts by itself and runs to its end.
    const status = await executeRun(ws, live.runId);
    rows = await runs(ws);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
    expect(status?.id).toBe(String(rows[1].id));
    expect((rows[1].cursor as { rerun?: boolean } | null)?.rerun).toBeUndefined(); // and it is not queued again
    const [queued] = await sql`SELECT detail FROM audit_log WHERE workspace_id = ${ws} AND action = 'pipeline_rerun_queued'`;
    expect(queued).toBeTruthy();
  });

  it("keeps the mark across the progress writes of the live slice", async () => {
    const { ws } = await fixture();
    const live = await startRun(ws);
    const asked = await requestRerun(ws);
    expect(asked).toMatchObject({ runId: live.runId, alreadyRunning: true, queued: true });
    // A second request while the first is queued changes nothing.
    expect((await requestRerun(ws)).queued).toBe(true);
    await executeRun(ws, live.runId);
    const rows = await runs(ws);
    expect(rows).toHaveLength(2); // one follow-up run, not two
    expect(rows.every((r) => r.status === "done")).toBe(true);
  });

  it("a paused run that the change resumes is also followed by a full run", async () => {
    const { ws } = await fixture();
    const first = await startRun(ws);
    await sql`UPDATE runs SET status = 'paused', lease_until = NULL WHERE workspace_id = ${ws} AND id = ${first.runId}`;
    const asked = await requestRerun(ws);
    // The caller continues the paused run (nobody else is working on it) ...
    expect(asked).toMatchObject({ runId: first.runId, alreadyRunning: false, resumed: true, queued: true });
    await executeRun(ws, asked.runId);
    // ... and because its finished steps predate the change, one more run follows.
    expect(await runs(ws)).toHaveLength(2);
  });

  it("with no live run the caller gets a fresh run to execute, as before", async () => {
    const { ws, build } = await fixture();
    const res = await setSegmentVisibility(ws, build, { action: "limit", categories: ["hr"], reason: "A remark about a member's work." }, APPROVER);
    expect(res.ok && res.runId).toBeTruthy();
    if (!res.ok || !res.runId) return;
    expect(res.queued).toBe(false);
    expect(visibilityMessage("Limited", res)).toMatch(/Re-running/);
    expect((await executeRun(ws, res.runId))?.status).toBe("done");
    expect(await runs(ws)).toHaveLength(1);
  });
});
