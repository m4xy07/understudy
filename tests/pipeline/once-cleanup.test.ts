// "The same action twice" on a demo workspace (answer, review, snapshot, model re-check), and the
// scheduled cleanup rule and its route. Needs a migrated, seeded database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { listClaims, listGapQuestions } from "@/lib/db/queries";
import { answerQuestion, listBlockingGaps, savePlanItem } from "@/lib/lacuna";
import { bulkApprove, reviewClaim } from "@/lib/relay";
import { createDemoWorkspace, createEmptyWorkspace } from "@/lib/pipeline/ingest";
import { runToEnd } from "@/lib/pipeline/run";
import { exclusive, leaseHeld } from "@/lib/pipeline/guard";
import { approveSnapshotOnce, busyMessage, reviewAlreadyDone } from "@/lib/pipeline/once";
import { fastFirst, liveStandin, REJUDGE_KEY, scheduleRejudge } from "@/lib/pipeline/rejudge";
import { purgeStale, touchWorkspace } from "@/lib/pipeline/cleanup";
import { GET as purgeRoute } from "@/app/api/cron/purge/route";
import { setSegmentVisibility, visibilityChangedSinceSnapshot } from "@/lib/tether/visibility";
import { CLUB, CLUB_ID } from "../helpers/club";
import { useFakeModel } from "../helpers/fake-model";

const sql = db();
const approver = CLUB.approverRole;
const leaver = CLUB.leaverRole;
let ws = "";
const extra: string[] = [];

async function drop(id: string) {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${id}`;
  });
}

beforeAll(async () => {
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  expect((await runToEnd(ws))?.status).toBe("done");
}, 120_000);

afterAll(async () => {
  delete process.env.CRON_SECRET;
  for (const id of [ws, ...extra]) if (id) await drop(id).catch(() => {});
  await sql.end();
});

describe("answering once", () => {
  it("two saves of one question at the same moment store one answer; the other is told so", async () => {
    const [q] = (await listGapQuestions(ws)).filter((x) => !x.answeredClaimId);
    const busy = { ok: false as const, error: busyMessage("This answer") };
    const save = (text: string) => exclusive(ws, `answer:${q.id}`, () => answerQuestion(ws, q.id, text, leaver), busy);
    const [a, b] = await Promise.all([save("Arjun owns this now; the steps are in the deploy notes."), save("Kabir owns this one, it is in the wiki.")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const refused = a.ok ? b : a;
    expect(refused.ok === false && refused.error).toBe("This answer is already being saved from another tab or an earlier click. Nothing was done twice; reload to see the result.");
    const answers = (await listClaims(ws)).filter((c) => c.origin === "leaver_answer");
    expect(answers).toHaveLength(1);
    // A later repeat (a stale tab) is refused by the question's own state.
    const late = await save("A third try.");
    expect(late).toEqual({ ok: false, error: "This question is already answered." });
  }, 60_000);

  it("the fast first reading makes no live model call, and no re-check is scheduled when the stand-in model is off", async () => {
    expect(liveStandin()).toBe(false); // vitest runs with the model disabled
    expect(await scheduleRejudge(ws)).toBeNull();
    const [q] = (await listGapQuestions(ws)).filter((x) => !x.answeredClaimId);
    const res = await fastFirst(() => answerQuestion(ws, q.id, "The request must reach the lab office by 1 Dec.", leaver));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.delta).toMatch(/B \d+/);
  }, 60_000);

  it("with a live stand-in, one re-check runs at a time and a second answer makes it go round again", async () => {
    const fake = useFakeModel("fake-rejudge");
    const before = process.env.LACUNA_MODEL;
    process.env.LACUNA_MODEL = "auto";
    try {
      expect(liveStandin()).toBe(true);
      const work = await scheduleRejudge(ws);
      expect(work).not.toBeNull();
      expect(await leaseHeld(ws, REJUDGE_KEY)).toBe(true); // what the header pill polls
      const [{ n: n0 }] = await sql`SELECT count(*)::int AS n FROM test_runs WHERE workspace_id = ${ws} AND trigger = 'model re-check'`;
      fake.delayMs = 200;
      const running = work!();
      await new Promise((r) => setTimeout(r, 80));
      // A second answer lands while the re-check is in flight: no second worker starts...
      expect(await scheduleRejudge(ws)).toBeNull();
      await running;
      const [{ n: n1 }] = await sql`SELECT count(*)::int AS n FROM test_runs WHERE workspace_id = ${ws} AND trigger = 'model re-check'`;
      // ...and the one worker goes round again, so the last stored run started after that answer.
      expect(n1 - n0).toBe(2 * CLUB.testRoles.length);
      expect(fake.calls.length).toBeGreaterThan(0); // the re-check really asked the model
      expect(await leaseHeld(ws, REJUDGE_KEY)).toBe(false);
      const [q] = await sql`SELECT score_delta FROM gap_questions WHERE workspace_id = ${ws} AND answered_at IS NOT NULL ORDER BY answered_at DESC LIMIT 1`;
      expect(String(q.score_delta)).toMatch(/B \d+/);
    } finally {
      if (before === undefined) delete process.env.LACUNA_MODEL;
      else process.env.LACUNA_MODEL = before;
      await fake.cleanup();
    }
  }, 120_000);
});

describe("reviewing and approving once", () => {
  it("approving an approved claim, or rejecting a rejected one, is a no-op with a note", async () => {
    expect((await bulkApprove(ws, approver)).ok).toBe(true);
    const claims = await listClaims(ws);
    const approved = claims.find((c) => c.review === "approved")!;
    expect(await reviewAlreadyDone(ws, approved.id, "approved")).toBe("Already approved. Nothing changed.");
    expect(await reviewAlreadyDone(ws, approved.id, "rejected")).toBeNull(); // a real change goes on
    const pending = claims.find((c) => c.review === "pending" && c.tier !== "C")!;
    expect(await reviewAlreadyDone(ws, pending.id, "approved")).toBeNull();
    expect((await reviewClaim(ws, pending.id, "rejected", approver, { note: "Not needed for the handover." })).ok).toBe(true);
    expect(await reviewAlreadyDone(ws, pending.id, "rejected")).toBe("Already rejected. Nothing changed.");
    expect(await reviewAlreadyDone(ws, "no-such-claim", "approved")).toBeNull(); // the module reports "not found"
  });

  it("three approvals at once and a repeat afterwards make exactly one snapshot version", async () => {
    for (const g of await listBlockingGaps(ws)) {
      await savePlanItem(ws, { responsibilityId: g.responsibilityId, checkKey: g.checkKey, owner: "Incoming lead", dueDate: "2026-11-30", riskNote: "Known gap." }, approver);
    }
    const out = await Promise.all([approveSnapshotOnce(ws, approver), approveSnapshotOnce(ws, approver), approveSnapshotOnce(ws, approver)]);
    // One approval makes v1; the other two wait for it and are told v1 already covers this state.
    expect(out.filter((r) => r.ok && !r.unchanged)).toHaveLength(1);
    expect(out.filter((r) => r.ok && r.unchanged?.version === 1)).toHaveLength(2);
    const again = await approveSnapshotOnce(ws, approver);
    expect(again).toMatchObject({ ok: true, unchanged: { version: 1 } });
    const versions = (await sql`SELECT version FROM snapshots WHERE workspace_id = ${ws} ORDER BY version`).map((r) => Number(r.version));
    expect(versions).toEqual([1]);
  }, 60_000);

  it("a real change after the snapshot does make a new version, and the leaver still gets the refusal", async () => {
    const res = await approveSnapshotOnce(ws, leaver);
    expect(res.ok).toBe(false); // never "already covered" for someone who may not approve
    const pending = (await listClaims(ws)).find((c) => c.review === "pending" && c.tier === "B" && c.state === "active");
    expect(pending).toBeDefined();
    expect((await reviewClaim(ws, pending!.id, "approved", approver, { note: "Checked.", evidenceOpened: true })).ok).toBe(true);
    const next = await approveSnapshotOnce(ws, approver);
    expect(next.ok && !next.unchanged && next.snapshot?.version).toBe(2);
  }, 60_000);
});

describe("finding 6: the visibility notice clears with the next approval", () => {
  it("a visibility change that leaves the payload as it was still lets the approver make a new version", async () => {
    expect(await visibilityChangedSinceSnapshot(ws)).toBe(false);
    const cited = new Set((await listClaims(ws)).flatMap((c) => c.citations.map((x) => x.segmentId)));
    const rows = await sql`
      SELECT DISTINCT ON (id) id, role_set, sensitivity FROM segments
      WHERE workspace_id = ${ws} AND kind = 'message' ORDER BY id, version DESC`;
    const seg = rows.find((r) => !cited.has(String(r.id)) && (r.sensitivity as string[]).length === 0 && (r.role_set as string[]).length === CLUB.roleOrder.length)!;
    expect(seg).toBeDefined();
    const before = Number((await sql`SELECT max(version) AS v FROM snapshots WHERE workspace_id = ${ws}`)[0].v);
    const res = await setSegmentVisibility(ws, String(seg.id), { action: "limit", categories: ["hr"], reason: "A remark about a member, not for everyone." }, approver);
    expect(res.ok && res.changed).toBe(true);
    // The pipeline run the change asks for is not part of this test.
    await sql`UPDATE runs SET status = 'failed', lease_until = NULL WHERE workspace_id = ${ws} AND status IN ('running', 'paused')`;
    expect(await visibilityChangedSinceSnapshot(ws)).toBe(true);
    // Before the fix: "already covers exactly this state", no new version, and the notice stayed for ever.
    const next = await approveSnapshotOnce(ws, approver);
    expect(next.ok && !next.unchanged && next.snapshot?.version).toBe(before + 1);
    expect(await visibilityChangedSinceSnapshot(ws)).toBe(false);
    // And a repeat after that is again a no-op.
    expect(await approveSnapshotOnce(ws, approver)).toMatchObject({ ok: true, unchanged: { version: before + 1 } });
  }, 60_000);
});

describe("scheduled cleanup", () => {
  async function aged(kind: "demo" | "empty", created: number, active: number | null = null): Promise<string> {
    const id = kind === "demo" ? (await createDemoWorkspace(CLUB_ID)).id : await createEmptyWorkspace("cleanup test");
    extra.push(id);
    await sql`UPDATE workspaces SET created_at = now() - make_interval(days => ${created}),
      last_active_at = now() - make_interval(days => ${active ?? created}) WHERE id = ${id}`;
    return id;
  }
  const exists = async (id: string) => (await sql`SELECT 1 FROM workspaces WHERE id = ${id}`).length === 1;
  // Scoped to this file's workspaces: a test run never deletes anything else in the database.
  const stale = async (dry: boolean) =>
    (await sql`SELECT purge_stale_workspaces(7, 14, 1000, ${dry}, ${[ws, ...extra]}::uuid[]) AS id`).map((r) => String(r.id));

  it("deletes an old demo copy with every child row; keeps fresh, active, locked and approved workspaces", async () => {
    const oldDemo = await aged("demo", 8);
    const freshDemo = await aged("demo", 6);
    const idleEmpty = await aged("empty", 30);
    const activeEmpty = await aged("empty", 30, 3);
    const locked = await aged("demo", 60);
    await sql`UPDATE workspaces SET access_mode = 'invite' WHERE id = ${locked}`;
    await sql`UPDATE workspaces SET created_at = now() - interval '90 days', last_active_at = now() - interval '90 days' WHERE id = ${ws}`; // has snapshots

    const [{ n: segs }] = await sql`SELECT count(*)::int AS n FROM segments WHERE workspace_id = ${oldDemo}`;
    expect(segs).toBeGreaterThan(0);

    // Dry mode names the same workspaces and deletes nothing.
    const would = await stale(true);
    expect(would).toEqual(expect.arrayContaining([oldDemo, idleEmpty]));
    for (const keep of [freshDemo, activeEmpty, locked, ws]) expect(would).not.toContain(keep);
    expect(await exists(oldDemo)).toBe(true);

    const gone = await stale(false);
    expect(gone).toEqual(expect.arrayContaining([oldDemo, idleEmpty]));
    expect(await exists(oldDemo)).toBe(false);
    expect(await exists(idleEmpty)).toBe(false);
    for (const keep of [freshDemo, activeEmpty, locked, ws]) expect(await exists(keep), keep).toBe(true);
    for (const table of ["sources", "segments", "people", "audit_log", "runs"]) {
      const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [oldDemo]);
      expect(n, table).toBe(0);
    }
    const [{ n: cache }] = await sql`SELECT count(*)::int AS n FROM model_cache`;
    expect(cache).toBeGreaterThan(0); // the model cache is never touched
    // The age-only purge of Round 2 is gone: the old name now applies the same keep rules.
    const [{ src }] = await sql`SELECT prosrc AS src FROM pg_proc WHERE proname = 'purge_workspaces'`;
    expect(String(src)).toContain("purge_stale_workspaces");
  }, 120_000);

  it("opening a workspace marks it active, at most once an hour", async () => {
    const id = await aged("empty", 30);
    await touchWorkspace(id);
    const [a] = await sql`SELECT last_active_at FROM workspaces WHERE id = ${id}`;
    expect(Date.now() - new Date(a.last_active_at).getTime()).toBeLessThan(60_000);
    await touchWorkspace(id);
    const [b] = await sql`SELECT last_active_at FROM workspaces WHERE id = ${id}`;
    expect(new Date(b.last_active_at).getTime()).toBe(new Date(a.last_active_at).getTime());
    expect(await stale(true)).not.toContain(id);
    await expect(touchWorkspace("not-a-uuid")).resolves.toBeUndefined();
  });

  it("the route is closed without the secret, and dry mode reports without deleting", async () => {
    const url = "http://localhost/api/cron/purge";
    delete process.env.CRON_SECRET;
    expect((await purgeRoute(new Request(url))).status).toBe(401); // no secret configured: closed, no default
    expect((await purgeRoute(new Request(url, { headers: { authorization: "Bearer " } }))).status).toBe(401);
    process.env.CRON_SECRET = "test-cron-secret";
    expect((await purgeRoute(new Request(url))).status).toBe(401);
    expect((await purgeRoute(new Request(url, { headers: { authorization: "Bearer wrong-cron-secret" } }))).status).toBe(401);
    const id = await aged("empty", 30);
    const res = await purgeRoute(new Request(`${url}?dry=1`, { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dry: boolean; count: number };
    expect(body).toMatchObject({ ok: true, dry: true, demoDays: 7, idleDays: 14 });
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(await exists(id)).toBe(true);
    expect((await purgeStale({ dry: true })).dry).toBe(true);
  });
});
