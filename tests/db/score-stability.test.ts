// A score must not get worse from an action that adds or reveals evidence, unless a claim was lost
// or a new conflict appeared. Regression for the live walkthrough: the leaver answered a blocking
// question (B 4 to 3), the approver widened a message and switched recovery on, and B was back at 4.
// Root cause: the first reading after an answer is rule-based; the background model re-check then
// read the same answer as only partly enough and reopened the gap, seconds later, while the
// approver was already doing something else. The stand-in model here is a fake that does exactly
// that: it calls the answered check "partial", and after the widen it drifts on one more check.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({
  /** Check keys the fake stand-in calls "partial" whatever the claims say. */
  partial: new Set<string>(),
  calls: 0,
}));

vi.mock("@/lib/model/client", async (original) => {
  const actual = await original<typeof import("@/lib/model/client")>();
  return {
    ...actual,
    modelAvailable: async () => true,
    callJson: async (opts: { user: string; jsonSchemaName: string }) => {
      if (opts.jsonSchemaName !== "standin_successor") return { ok: false as const, error: "not in cache" };
      model.calls++;
      const checks = [...opts.user.matchAll(/^- ([a-z0-9_]+): /gm)].map((m) => m[1]);
      const ids = [...opts.user.matchAll(/^\[([^\]]+)\] \(/gm)].map((m) => m[1]);
      return {
        ok: true as const,
        cached: false,
        data: {
          checks: checks.map((k) => model.partial.has(k)
            ? { check_key: k, status: "partial", claim_ids: ids, blocker: "I would still have to ask someone." }
            : { check_key: k, status: "can_do", claim_ids: ids, blocker: "" }),
        },
      };
    },
  };
});

import { db } from "@/lib/db/client";
import { getLatestTestRun, listResponsibilities } from "@/lib/db/queries";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { answerQuestion, buildInventory, buildQuestions, listQuestions, runTest, setLeaverUnreachable } from "@/lib/lacuna";
import { setSegmentVisibility } from "@/lib/tether/visibility";
import type { CheckResult, RoleKey, TestRun } from "@/lib/types";
import { loadGroundTruth, seedGroundTruthClaims } from "../lacuna/gt-seed";
import { CLUB, CLUB_ID } from "../helpers/club";

delete process.env.LACUNA_MODEL;
const sql = db();
const APPROVER = CLUB.approverRole as RoleKey;
const SUCCESSOR = CLUB.successorRole as RoleKey;
const LEAVER = CLUB.leaverRole as RoleKey;
const RANK = { covered: 3, partial: 2, conflicting: 1, missing: 0, restricted: 0 } as const;

let ws = "";
let answered = { responsibilityId: "", checkKey: "" };
let answerClaim = "";
const latest = async () => (await getLatestTestRun(ws, SUCCESSOR))!;
const check = (run: TestRun, g = answered): CheckResult =>
  run.results.find((r) => r.responsibilityId === g.responsibilityId && r.checkKey === g.checkKey)!;
/** No check reads lower in `after` than in `before`. */
function notWorse(before: TestRun, after: TestRun): string[] {
  const was = new Map(before.results.map((r) => [`${r.responsibilityId}|${r.checkKey}`, r.coverage]));
  return after.results
    .filter((r) => RANK[r.coverage] < RANK[was.get(`${r.responsibilityId}|${r.checkKey}`) ?? "missing"])
    .map((r) => `${r.responsibilityId}|${r.checkKey}: ${was.get(`${r.responsibilityId}|${r.checkKey}`)} -> ${r.coverage}`);
}

beforeAll(async () => {
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  await seedGroundTruthClaims(ws);
  await buildInventory(ws);
  for (const role of CLUB.testRoles) await runTest(ws, role, { trigger: "test" });
  await buildQuestions(ws);
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

describe("leaver answers, approver widens, recovery on", () => {
  it("the answer closes its blocking gap, and the model re-check does not reopen it", async () => {
    const before = await latest();
    const q = (await listQuestions(ws)).find((x) => !x.answeredClaimId && x.checkKey === "credential_owner")!;
    expect(q).toBeTruthy();
    answered = { responsibilityId: q.responsibilityId, checkKey: q.checkKey };
    expect(check(before).coverage).not.toBe("covered");

    // From here on the stand-in model reads this check as only partly answered, as the live one did.
    model.partial.add("credential_owner");
    const res = await answerQuestion(ws, q.id, String(CLUB.demo!.sampleAnswer), LEAVER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    answerClaim = res.claimId;
    const afterAnswer = await latest();
    expect(check(afterAnswer)).toMatchObject({ coverage: "covered", bestTrust: "leaver_said" });
    expect(check(afterAnswer).claimIds).toContain(answerClaim);
    expect(afterAnswer.scores.b).toBe(before.scores.b - 1);

    // The background re-check (pipeline/rejudge.ts): only this responsibility, no "keep the earlier result".
    const calls = model.calls;
    await Promise.all(CLUB.testRoles.map((role) =>
      runTest(ws, role, { trigger: "model re-check", only: [q.responsibilityId], rejudge: true })));
    expect(model.calls).toBeGreaterThan(calls); // the model was asked and said "partial"
    const rechecked = await latest();
    expect(check(rechecked).coverage).toBe("covered");
    expect(rechecked.scores.b).toBe(afterAnswer.scores.b);
    expect(notWorse(afterAnswer, rechecked)).toEqual([]);
  });

  it("widening a message and re-running does not lower any check, even when the model drifts", async () => {
    const before = await latest();
    const text = (loadGroundTruth() as unknown as { decoys?: { group?: string; containsText?: string }[] })
      .decoys?.find((d) => d.group === "false_positive")?.containsText as string;
    const [seg] = await sql`
      SELECT id FROM segments WHERE workspace_id = ${ws} AND position(${text} in text) > 0 AND role_set_original IS NOT NULL
      ORDER BY version DESC LIMIT 1`;
    expect(seg).toBeTruthy();
    const widened = await setSegmentVisibility(ws, String(seg.id),
      { action: "widen", roles: "source", reason: "Routine deposit, it backs the lab booking steps." }, APPROVER);
    expect(widened.ok).toBe(true);

    // The model now reads one more covered check lower (a longer prompt, a different answer).
    const drift = before.results.find((r) => r.coverage === "covered" && r.claimIds.length > 0
      && !(r.responsibilityId === answered.responsibilityId && r.checkKey === answered.checkKey))!;
    expect(drift).toBeTruthy();
    model.partial.add(drift.checkKey);

    // What the pipeline's test step does on a re-run: every responsibility, keeping earlier better results.
    for (const role of CLUB.testRoles) await runTest(ws, role, { trigger: "run", keepEarlier: true });
    const after = await latest();
    expect(notWorse(before, after)).toEqual([]);
    expect(after.scores.b).toBeLessThanOrEqual(before.scores.b);
    expect(check(after).coverage).toBe("covered");
  });

  it("switching recovery on does not reopen the gap the leaver closed", async () => {
    const before = await latest();
    const res = await setLeaverUnreachable(ws, true, APPROVER, "Regression test");
    expect(res.ok).toBe(true);
    const after = await latest();
    expect(notWorse(before, after)).toEqual([]);
    expect(after.scores.b).toBeLessThanOrEqual(before.scores.b);
    expect(check(after)).toMatchObject({ coverage: "covered", bestTrust: "leaver_said" });
  });

  it("a real change still shows: a new conflict on the answer reopens the check", async () => {
    const before = await latest();
    await sql`UPDATE claims SET state = 'conflicting', updated_at = now() WHERE workspace_id = ${ws} AND id = ${answerClaim}`;
    for (const role of CLUB.testRoles) await runTest(ws, role, { trigger: "run", keepEarlier: true });
    const after = await latest();
    expect(check(after).coverage).not.toBe("covered");
    expect(after.scores.b).toBe(before.scores.b + 1);
    await sql`UPDATE claims SET state = 'active', updated_at = now() WHERE workspace_id = ${ws} AND id = ${answerClaim}`;
  });

  it("a model re-check that does lower a check says which one and why on the run", async () => {
    // A check the record covers (no direct answer on it): the re-check may lower it, and explains it.
    const resps = await listResponsibilities(ws);
    for (const role of CLUB.testRoles) await runTest(ws, role, { model: "off", trigger: "first reading" });
    const first = await latest();
    const target = first.results.find((r) => r.coverage === "covered" && r.claimIds.length > 0
      && r.responsibilityId !== answered.responsibilityId)!;
    model.partial.clear();
    model.partial.add(target.checkKey);
    await runTest(ws, SUCCESSOR, { trigger: "model re-check", only: [target.responsibilityId], rejudge: true });
    const [row] = await sql`
      SELECT model_note FROM test_runs WHERE workspace_id = ${ws} AND role = ${SUCCESSOR} ORDER BY created_at DESC LIMIT 1`;
    const key = resps.find((r) => r.id === target.responsibilityId)!.key;
    expect(String(row.model_note)).toMatch(/^The model re-check read .* lower than the first reading: /);
    expect(String(row.model_note)).toContain(key);
    expect(String(row.model_note)).toContain("is now partial (I would still have to ask someone)");
  });
});
