// Tier B approved by responsibility, on the database: approver only, only after the list was
// opened, tier C and conflicts never, a repeat changes nothing, one re-test for the group, and the
// read-back item resolves once its claim is approved this way.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { listResponsibilities } from "@/lib/db/queries";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { buildInventory, listBlockingGaps, runTest, savePlanItem } from "@/lib/lacuna";
import { retestResponsibilities } from "@/lib/pipeline/retest";
import { approveGroup, approveSnapshot, compileHandover, listReviewGroups, resolveReadbackItems } from "@/lib/relay";
import type { RoleKey } from "@/lib/types";
import { seedGroundTruthClaims } from "../lacuna/gt-seed";
import { CLUB, CLUB_ID } from "../helpers/club";

process.env.LACUNA_MODEL = "off";
const sql = db();
const APPROVER = CLUB.approverRole as RoleKey;
const SUCCESSOR = CLUB.successorRole as RoleKey;
const LEAVER = CLUB.leaverRole as RoleKey;
let ws = "";
let groupKey = "";
let respId = "";
const reviewOf = async (id: string) => String((await sql`SELECT review FROM claims WHERE workspace_id = ${ws} AND id = ${id}`)[0].review);

beforeAll(async () => {
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  await seedGroundTruthClaims(ws);
  await buildInventory(ws);
  for (const role of CLUB.testRoles) await runTest(ws, role, { model: "off", trigger: "test" });
  // Every seeded claim starts as plain pending tier B; the tests below plant the exceptions.
  await sql`UPDATE claims SET tier = 'B', review = 'pending', importance = 'normal' WHERE workspace_id = ${ws} AND state = 'active'`;
  const rb = (CLUB.readback as unknown as { key: string; entity: string; attribute: string }[]).find((r) => r.key === "competition_date")!;
  const resp = (await listResponsibilities(ws)).find((r) => r.entities.includes(rb.entity))!;
  respId = resp.id;
  groupKey = `resp:${resp.id}`;
}, 180_000);

afterAll(async () => {
  if (ws) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("approveGroup", () => {
  it("refuses everyone but the approver, and the approver until the list was opened", async () => {
    const group = (await listReviewGroups(ws)).find((g) => g.key === groupKey)!;
    expect(group.claims.length).toBeGreaterThan(0);
    const ids = group.claims.map((c) => c.id);
    const leaver = await approveGroup(ws, LEAVER, groupKey, { expanded: true, claimIds: ids });
    expect(leaver.ok === false && leaver.code).toBe("leaver_cannot_approve");
    const successor = await approveGroup(ws, SUCCESSOR, groupKey, { expanded: true, claimIds: ids });
    expect(successor.ok === false && successor.code).toBe("not_approver");
    const closed = await approveGroup(ws, APPROVER, groupKey, { expanded: false, claimIds: ids });
    expect(closed.ok === false && closed.code).toBe("group_not_opened");
    expect(await reviewOf(ids[0])).toBe("pending");
  });

  it("approves the pending tier B claims of the group; tier C, a conflict and a claim not on screen stay pending", async () => {
    const before = (await listReviewGroups(ws)).find((g) => g.key === groupKey)!;
    expect(before.claims.length).toBeGreaterThanOrEqual(4);
    const [blocking, conflict, unseen, ...rest] = before.claims.map((c) => c.id);
    await sql`UPDATE claims SET importance = 'blocking' WHERE workspace_id = ${ws} AND id = ${blocking}`; // effective tier C
    await sql`UPDATE claims SET state = 'conflicting' WHERE workspace_id = ${ws} AND id = ${conflict}`;
    const shown = [blocking, conflict, ...rest]; // the client still names them; the server decides
    const res = await approveGroup(ws, APPROVER, groupKey, { expanded: true, claimIds: shown });
    expect(res).toMatchObject({ ok: true, approved: rest.length, responsibilityId: respId });
    for (const id of rest) expect(await reviewOf(id)).toBe("approved");
    for (const id of [blocking, conflict, unseen]) expect(await reviewOf(id)).toBe("pending");
    const events = await sql`
      SELECT claim_id, event, data FROM claim_events WHERE workspace_id = ${ws} AND event = 'claim_approved' AND claim_id = ANY(${rest}::text[])`;
    expect(events).toHaveLength(rest.length);
    const data = typeof events[0].data === "string" ? JSON.parse(events[0].data) : events[0].data;
    expect(data).toMatchObject({ tier: "B", bulk: true, group: groupKey });
    const logs = await sql`SELECT 1 FROM audit_log WHERE workspace_id = ${ws} AND action = 'approve_group'`;
    expect(logs.length).toBe(1);
    await sql`UPDATE claims SET state = 'active', importance = 'normal' WHERE workspace_id = ${ws} AND id = ANY(${[blocking, conflict]}::text[])`;
  });

  it("is idempotent: a repeat approves nothing, and an unknown group is refused", async () => {
    const left = (await listReviewGroups(ws)).find((g) => g.key === groupKey)!;
    const ids = left.claims.map((c) => c.id);
    const first = await approveGroup(ws, APPROVER, groupKey, { expanded: true, claimIds: ids });
    expect(first).toMatchObject({ ok: true, approved: ids.length });
    const eventsBefore = Number((await sql`SELECT count(*)::int AS n FROM claim_events WHERE workspace_id = ${ws}`)[0].n);
    const again = await approveGroup(ws, APPROVER, groupKey, { expanded: true, claimIds: ids });
    expect(again).toMatchObject({ ok: true, approved: 0 });
    expect(Number((await sql`SELECT count(*)::int AS n FROM claim_events WHERE workspace_id = ${ws}`)[0].n)).toBe(eventsBefore);
    const unknown = await approveGroup(ws, APPROVER, "resp:nope", { expanded: true, claimIds: ids });
    expect(unknown.ok === false && unknown.code).toBe("group_not_found");
  });

  it("re-tests once for the whole group, for every tested role", async () => {
    const calls: string[] = [];
    const ok = await retestResponsibilities(ws, [respId], "review group approved", {
      run: (async (_ws: string, role: RoleKey, opts?: { only?: string[] }) => {
        calls.push(`${role}:${(opts?.only ?? []).join(",")}`);
        return runTest(ws, role, { model: "off", trigger: "review group approved", only: opts?.only });
      }) as typeof runTest,
    });
    expect(ok).toBe(true);
    expect(calls.sort()).toEqual(CLUB.testRoles.map((r) => `${r}:${respId}`).sort());
    const none = await retestResponsibilities(ws, [], "review group approved", {
      run: (() => { throw new Error("must not run"); }) as unknown as typeof runTest,
    });
    expect(none).toBe(true);
  });

  it("the read-back item of that responsibility resolves in the snapshot and the handover says so", async () => {
    for (const g of await listBlockingGaps(ws)) {
      await savePlanItem(ws, { responsibilityId: g.responsibilityId, checkKey: g.checkKey, owner: "Arjun Rao", dueDate: "2026-12-30", riskNote: "May slip" }, APPROVER);
    }
    const snap = await approveSnapshot(ws, APPROVER);
    expect(snap.ok).toBe(true);
    if (!snap.ok || !snap.snapshot) return;
    const resolved = await resolveReadbackItems(ws, snap.snapshot.id);
    expect(resolved.answers.competition_date).not.toBeNull();
    const doc = (await compileHandover(ws, SUCCESSOR)).doc!;
    const lines = doc.sections.find((s) => s.key === "synthesis")!.lines.map((l) => l.text);
    expect(lines).toContain("Read back: Competition date.");
    const actions = doc.sections.find((s) => s.key === "actions")!.lines.map((l) => l.text);
    expect(new Set(actions).size).toBe(actions.length);
  });
});
