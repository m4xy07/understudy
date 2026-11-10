// End-to-end over the walking skeleton: demo ingest -> run -> answer -> review -> snapshot -> handover.
// Needs a migrated database and data/demo (pnpm db:up && pnpm db:migrate).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { executeRun, startRun } from "@/lib/pipeline/run";
import { getLatestTestRun, listClaims, listGapQuestions } from "@/lib/db/queries";
import { answerQuestion, listBlockingGaps, savePlanItem } from "@/lib/lacuna";
import { approveSnapshot, bulkApprove, canonicalJson, compileHandover, reviewClaim } from "@/lib/relay";

const sql = db();
let ws = "";

beforeAll(async () => {
  ws = (await createDemoWorkspace()).id;
  const { runId } = await startRun(ws);
  const run = await executeRun(ws, runId);
  expect(run?.status).toBe("done");
}, 120_000);

afterAll(async () => {
  if (ws) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("walking skeleton pipeline", () => {
  it("re-importing the demo into the same workspace does not duplicate segments", async () => {
    const [{ n: before }] = await sql`SELECT count(*)::int AS n FROM segments WHERE workspace_id = ${ws}`;
    expect(before).toBeGreaterThan(0);
  });

  it("produces cited claims, a test run with B/C/K and at most ten questions", async () => {
    const claims = await listClaims(ws);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.citations.length > 0)).toBe(true);
    const run = await getLatestTestRun(ws, "tech_lead");
    expect(run).not.toBeNull();
    expect(run!.scores.c).toBeGreaterThanOrEqual(0);
    const qs = await listGapQuestions(ws);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.length).toBeLessThanOrEqual(10);
  });

  it("only the leaver answers; an answer is 'leaver_said' and raises C but not K", async () => {
    const [q] = (await listGapQuestions(ws)).filter((x) => !x.answeredClaimId);
    const notLeaver = await answerQuestion(ws, q.id, "Some answer", "president");
    expect(notLeaver.ok).toBe(false);
    const res = await answerQuestion(ws, q.id, "Ask the league office; the form is on their site.", "leaver", ["president", "tech_lead"]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.after.c).toBeGreaterThanOrEqual(res.before!.c);
    if (res.before!.k !== null && res.after.k !== null) expect(res.after.k).toBeLessThanOrEqual(res.before!.k);
    const claim = (await listClaims(ws)).find((c) => c.id === res.claimId)!;
    expect(claim.trust).toBe("leaver_said");
    expect(claim.roleSet).not.toContain("new_member");
  });

  it("the leaver can never approve, and nobody but the president can", async () => {
    expect((await approveSnapshot(ws, "leaver")).ok).toBe(false);
    expect((await approveSnapshot(ws, "tech_lead")).ok).toBe(false);
    expect((await bulkApprove(ws, "leaver", ["A", "B"])).ok).toBe(false);
  });

  it("release rule, hash and per-role compile with a restricted stub", async () => {
    expect((await bulkApprove(ws, "president", ["A", "B"])).ok).toBe(true);
    const tierC = (await listClaims(ws)).filter((c) => c.tier === "C" && c.review === "pending");
    for (const c of tierC) {
      expect((await reviewClaim(ws, c.id, "approved", "president")).ok).toBe(false); // needs a reason
      expect((await reviewClaim(ws, c.id, "approved", "president", { note: "Checked the evidence." })).ok).toBe(false); // evidence not opened
      expect((await reviewClaim(ws, c.id, "approved", "president", { note: "Checked the evidence.", evidenceOpened: true })).ok).toBe(true);
    }
    const gaps = await listBlockingGaps(ws);
    if (gaps.length) {
      expect((await approveSnapshot(ws, "president")).ok).toBe(false); // B > 0 and no plan yet
      for (const g of gaps) {
        await savePlanItem(ws, { responsibilityId: g.responsibilityId, checkKey: g.checkKey, owner: "Incoming tech lead", dueDate: "2026-11-30", riskNote: "Known gap." }, "president");
      }
    }
    const snap = await approveSnapshot(ws, "president");
    expect(snap.ok).toBe(true);
    expect(snap.snapshot!.hash).toMatch(/^[0-9a-f]{64}$/);

    const lead = await compileHandover(ws, "tech_lead");
    const member = await compileHandover(ws, "new_member");
    const president = await compileHandover(ws, "president");
    const allItems = president.groups.flatMap((g) => g.items).length; // the president sees every role set in the demo
    const leadItems = lead.groups.flatMap((g) => g.items).length;
    const memberItems = member.groups.flatMap((g) => g.items).length;
    // Withheld counts every approved claim the role may not see, including ones the tech lead
    // cannot see either (e.g. #finance), so compare with the president's view, not the tech lead's.
    expect(member.withheld).toBe(allItems - memberItems);
    expect(lead.withheld).toBe(allItems - leadItems);
    expect(member.withheld).toBeGreaterThan(0);
    expect(member.stubLine).toBe(member.withheld === 1
      ? "1 restricted item. Ask the approver (Club President)."
      : `${member.withheld} restricted items. Ask the approver (Club President).`);
    expect(JSON.stringify(member)).not.toContain("league office");
    expect(JSON.stringify(lead)).toContain("league office");
  });

  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});
