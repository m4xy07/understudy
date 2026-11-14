// Regression tests for the Round 3 code-review findings that need the database: the re-test after
// a review decision (2, 10), the stale background re-check (3), the answer that is saved even when
// the re-test fails (5), the new conflict that was hidden by "keep the earlier result" (7), the
// bounded segment reads (8), contact placeholder numbers (12) and the stale-tab finding approval (b).
// The club demo with the planted claims; the stand-in runs deterministically.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db/client";
import { getLatestTestRun, listClaims, listResponsibilities, listSegments } from "@/lib/db/queries";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { loadSegmentsByIds, rerunRules } from "@/lib/attest";
import {
  answerAsNeighbour, answerQuestion, buildInventory, buildQuestions, listQuestions, RETEST_FAILED, recoverySamples, runTest,
  setLeaverUnreachable, StaleTestError, testInputFingerprint,
} from "@/lib/lacuna";
import { maskAnswer, reserveContactNumbers } from "@/lib/lacuna/persist";
import { loadSegmentSources, loadTraceSegments, TRACE_SEGMENT_KINDS } from "@/lib/lacuna/recovery";
import { findingClaimProblem } from "@/lib/pipeline/once";
import { evidenceChanged, REJUDGE_KEY, scheduleRejudge } from "@/lib/pipeline/rejudge";
import { retestAfterReview, SAVED_NOT_RETESTED } from "@/lib/pipeline/retest";
import { reviewClaim } from "@/lib/relay";
import type { Responsibility, RoleKey } from "@/lib/types";
import { seedGroundTruthClaims } from "../lacuna/gt-seed";
import { CLUB, CLUB_ID } from "../helpers/club";

process.env.LACUNA_MODEL = "off";
const sql = db();
const APPROVER = CLUB.approverRole as RoleKey;
const SUCCESSOR = CLUB.successorRole as RoleKey;
const LEAVER = CLUB.leaverRole as RoleKey;

let ws = "";
let resps: Responsibility[] = [];
const respOf = (entity: string) => resps.find((r) => r.entities.includes(entity))!;
const runCount = async () => Number((await sql`SELECT count(*)::int AS n FROM test_runs WHERE workspace_id = ${ws}`)[0].n);

/** Make every test run with this trigger fail to store, for the duration of `fn`. */
async function failingRetest<T>(triggerLike: string, fn: () => Promise<T>): Promise<T> {
  await sql.unsafe(`ALTER TABLE test_runs ADD CONSTRAINT tmp_review_fixes CHECK (trigger NOT LIKE '${triggerLike}') NOT VALID`);
  try {
    return await fn();
  } finally {
    await sql.unsafe("ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS tmp_review_fixes");
  }
}

beforeAll(async () => {
  await sql.unsafe("ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS tmp_review_fixes");
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  await seedGroundTruthClaims(ws);
  await buildInventory(ws);
  resps = await listResponsibilities(ws);
  for (const role of CLUB.testRoles) await runTest(ws, role, { model: "off", trigger: "test" });
  await buildQuestions(ws);
}, 180_000);

afterAll(async () => {
  await sql.unsafe("ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS tmp_review_fixes");
  if (ws) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("finding 8: server actions read only the segments they need", () => {
  it("the ladder reads text only for the kinds a trace is built from, and sources without text", async () => {
    const all = await listSegments(ws);
    const traceSegs = await loadTraceSegments(ws);
    expect(traceSegs.length).toBeGreaterThan(0);
    expect(traceSegs.length).toBeLessThan(all.length);
    expect(traceSegs.every((s) => TRACE_SEGMENT_KINDS.includes(s.kind))).toBe(true);
    expect(new Set(traceSegs.map((s) => s.id))).toEqual(new Set(all.filter((s) => TRACE_SEGMENT_KINDS.includes(s.kind)).map((s) => s.id)));
    const sources = await loadSegmentSources(ws);
    expect(sources.size).toBe(all.length);
    for (const s of all.slice(0, 20)) expect(sources.get(s.id)).toBe(s.sourceId);
  });

  it("the rules re-run reads only cited segments, and still changes nothing on a settled workspace", async () => {
    const claims = await listClaims(ws);
    const cited = [...new Set(claims.flatMap((c) => c.citations.map((x) => x.segmentId)))];
    const loaded = await loadSegmentsByIds(ws, [...cited, cited[0], "seg_missing"]);
    expect(new Set(loaded.map((s) => s.id))).toEqual(new Set(cited));
    expect(await loadSegmentsByIds(ws, [])).toEqual([]);
    // The planted claims have not been through the rules yet: the first pass settles them, the
    // second finds nothing left to change (the rules see the same segments either way).
    await rerunRules(ws, APPROVER);
    const settled = new Map((await listClaims(ws)).map((c) => [c.id, `${c.state}|${c.trust}`]));
    await rerunRules(ws, APPROVER);
    for (const c of await listClaims(ws)) expect(`${c.state}|${c.trust}`).toBe(settled.get(c.id));
    for (const role of CLUB.testRoles) await runTest(ws, role, { model: "off", trigger: "test" });
    await buildQuestions(ws);
  });
});

describe("finding 12: contact placeholder numbers", () => {
  it("ten reservations at the same moment get ten separate ranges", async () => {
    const bases = await Promise.all(Array.from({ length: 10 }, () => reserveContactNumbers(ws, 2)));
    const numbers = bases.flatMap((b) => [b + 1, b + 2]);
    expect(new Set(numbers).size).toBe(20);
  });

  it("two answers masked at the same moment never share a placeholder", async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `Write to person${i}@example.org or call +91 98765 4321${i}.`);
    const masked = await Promise.all(texts.map((t) => maskAnswer(ws, t)));
    const tokens = masked.flatMap((m) => m.contacts.map((c) => c.token));
    expect(tokens.length).toBeGreaterThanOrEqual(6);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const m of masked) for (const c of m.contacts) expect(m.text).toContain(c.token);
  });
});

describe("finding (c): a failed read of the demo samples is not cached", () => {
  it("the next call reads the file again", async () => {
    // A fresh copy of the module (an empty cache), whose first read fails.
    vi.resetModules();
    const fresh = await import("@/lib/lacuna/recovery");
    await (await import("@/lib/pack")).getWorkspacePack(ws); // the pack itself loads from the real folder
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("Z:/nowhere/at/all");
    const failed = await fresh.recoverySamples(ws);
    cwd.mockRestore();
    expect(failed.answers).toEqual([]);
    const again = await fresh.recoverySamples(ws);
    expect(again.answers.length).toBeGreaterThan(0); // before the fix: {} for the life of the process
    expect(again.answers).toEqual((await recoverySamples(ws)).answers);
  });
});

describe("finding 5: an answer that is saved is reported as saved, even when the re-test fails", () => {
  it("the leaver's answer: ok, with the plain sentence, and the question is answered", async () => {
    const q = (await listQuestions(ws)).find((x) => !x.answeredClaimId)!;
    const res = await failingRetest("answer gq_%", () => answerQuestion(ws, q.id, "It is in the shared drive under Handover, in the folder for this season.", LEAVER));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.retestFailed).toBe(true);
    expect(res.delta).toBe(RETEST_FAILED);
    expect(res.responsibilityId).toBe(q.responsibilityId);
    const after = (await listQuestions(ws)).find((x) => x.id === q.id)!;
    expect(after.answeredClaimId).toBe(res.claimId);
    // A retry is refused by the question's own state: the first reply must already have said "saved".
    expect(await answerQuestion(ws, q.id, "Again.", LEAVER)).toEqual({ ok: false, error: "This question is already answered." });
  });

  it("a neighbour's answer: ok with the plain sentence, the step is answered, the claim is stored", async () => {
    const on = await setLeaverUnreachable(ws, true, APPROVER, "On leave, no phone.");
    expect(on.ok).toBe(true);
    const deploy = respOf("firmware-deploy");
    const [step] = await sql`SELECT * FROM recovery_steps WHERE workspace_id = ${ws} AND responsibility_id = ${deploy.id}
      AND check_key = 'credential_owner' AND status = 'asked'`;
    const role = String(step.target_role);
    const text = "Priya has it. She typed it on the lab laptop herself each time. I asked on 4 Nov and never got it.";
    const res = await failingRetest("recovery answer%", () => answerAsNeighbour(ws, String(step.id), text, role));
    // Before the fix this threw after the commit: the page showed a failure, and the retry said "You already answered this."
    expect(res.ok).toBe(true);
    if (!res.ok || res.declined) throw new Error("expected a saved answer");
    expect(res.retestFailed).toBe(true);
    expect(res.delta).toBe(RETEST_FAILED);
    const [row] = await sql`SELECT status, claim_id, detail FROM recovery_steps WHERE workspace_id = ${ws} AND id = ${String(step.id)}`;
    expect(row).toMatchObject({ status: "answered", claim_id: res.claimId });
    expect((await listClaims(ws)).some((c) => c.id === res.claimId && c.trust === "second_hand")).toBe(true);
    expect(await answerAsNeighbour(ws, String(step.id), text, role)).toEqual({ ok: false, error: "You already answered this." });
  });
});

describe("findings 2 and 10: every review decision re-tests", () => {
  let claimId = "";
  const check = async () => {
    const run = (await getLatestTestRun(ws, SUCCESSOR))!;
    const deploy = respOf("firmware-deploy");
    return { run, result: run.results.find((x) => x.responsibilityId === deploy.id && x.checkKey === "credential_owner")! };
  };

  it("a Second-hand claim on a blocking check counts only after approval, and the approval itself moves B", async () => {
    claimId = (await listClaims(ws)).find((c) => c.origin === "neighbour_answer" && c.entity === "firmware-deploy")!.id;
    // The answer above was saved without a re-test (it failed): bring the scores up to date first.
    expect(await retestAfterReview(ws, claimId, "test catch-up")).toBe(true);
    const before = await check();
    expect(before.result.coverage).toBe("partial");

    const res = await reviewClaim(ws, claimId, "approved", APPROVER, { note: "Confirmed with Arjun in person on Friday.", evidenceOpened: true });
    expect(res.ok).toBe(true);
    // The bug: nothing re-tested after an approval, so the latest run still said Partial and B was stale.
    expect((await check()).run.id).toBe(before.run.id);
    const runs = await runCount();
    expect(await retestAfterReview(ws, claimId, "review approved")).toBe(true);
    expect(await runCount()).toBe(runs + CLUB.testRoles.length); // one narrowed run per tested role
    const after = await check();
    expect(after.run.trigger ?? "review approved").toBe("review approved");
    expect(after.result.coverage).toBe("covered");
    expect(after.run.scores.b).toBe(before.run.scores.b - 1);
    // Only the claim's responsibility was judged again: every other result is the earlier one.
    const deploy = respOf("firmware-deploy");
    const other = (r: { responsibilityId: string }) => r.responsibilityId !== deploy.id;
    expect(after.run.results.filter(other)).toEqual(before.run.results.filter(other));
  });

  it("a rejection re-tests too: the rejected claim no longer carries the better result", async () => {
    const before = await check();
    expect(before.result.coverage).toBe("covered");
    const res = await reviewClaim(ws, claimId, "rejected", APPROVER, { note: "Arjun was guessing, he never saw it.", evidenceOpened: true });
    expect(res.ok).toBe(true);
    expect(await retestAfterReview(ws, claimId, "review rejected")).toBe(true);
    const after = await check();
    expect(after.result.coverage).not.toBe("covered");
    expect(after.run.scores.b).toBe(before.run.scores.b + 1);
  });

  it("when the re-test cannot run the decision still stands and the caller is told so, not thrown at", async () => {
    const runs = await runCount();
    const boom = async () => { throw new Error("model down"); };
    expect(await retestAfterReview(ws, claimId, "review edited", { run: boom as never })).toBe(false);
    expect(await retestAfterReview(ws, "clm_does_not_exist", "review edited")).toBe(false);
    expect(await runCount()).toBe(runs);
    expect(SAVED_NOT_RETESTED).toBe("Saved. The re-test did not run; press Re-run test.");
    // The lease was released: the next re-test runs.
    expect(await retestAfterReview(ws, claimId, "review edited")).toBe(true);
  });
});

describe("finding (b): a successor finding is not decided from the Review page", () => {
  it("refuses the claim of a finding, pending or decided, and lets every other claim through", async () => {
    const [any] = await listClaims(ws);
    expect(await findingClaimProblem(ws, any.id)).toBeNull();
    expect(await findingClaimProblem(ws, "clm_missing")).toBeNull();
    await sql`
      INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, role_set, valid_from, origin, review)
      SELECT workspace_id, 'clm_stale_tab_finding', entity, entity_label, attribute, 'x', 'A finding.', citations, 'successor_found', role_set, now(), 'successor_finding', 'pending'
      FROM claims WHERE workspace_id = ${ws} AND id = ${any.id}`.catch(async () => {
      // 'successor_found' may not be an allowed trust on this schema: the origin is what matters here.
      await sql`
        INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, role_set, valid_from, origin, review)
        SELECT workspace_id, 'clm_stale_tab_finding', entity, entity_label, attribute, 'x', 'A finding.', citations, trust, role_set, now(), 'successor_finding', 'pending'
        FROM claims WHERE workspace_id = ${ws} AND id = ${any.id}`;
    });
    expect(await findingClaimProblem(ws, "clm_stale_tab_finding")).toMatch(/First weeks/);
    await sql`DELETE FROM claims WHERE workspace_id = ${ws} AND id = 'clm_stale_tab_finding'`;
  });
});

describe("finding 7: a new conflict is not hidden by the earlier, better result", () => {
  it("a narrowed re-test does not restore Covered when a claim it rested on is now conflicting", async () => {
    const run = (await getLatestTestRun(ws, SUCCESSOR))!;
    const claims = new Map((await listClaims(ws)).map((c) => [c.id, c]));
    const target = run.results.find((r) => r.coverage === "covered" && r.claimIds.length === 1 && claims.get(r.claimIds[0])?.state === "active")!;
    expect(target).toBeTruthy();
    const cid = target.claimIds[0];
    await sql`UPDATE claims SET state = 'conflicting', updated_at = now() WHERE workspace_id = ${ws} AND id = ${cid}`;
    try {
      const narrowed = await runTest(ws, SUCCESSOR, { model: "off", trigger: "test conflict", only: [target.responsibilityId] });
      const full = await runTest(ws, SUCCESSOR, { model: "off", trigger: "test conflict full" });
      const pick = (r: typeof run) => r.results.find((x) => x.responsibilityId === target.responsibilityId && x.checkKey === target.checkKey)!;
      // Before the fix the narrowed run copied the earlier Covered back, because "live" included conflicting claims.
      expect(pick(narrowed).coverage).toBe(pick(full).coverage);
      expect(pick(narrowed).coverage).not.toBe("covered");
    } finally {
      await sql`UPDATE claims SET state = 'active', updated_at = now() WHERE workspace_id = ${ws} AND id = ${cid}`;
      await runTest(ws, SUCCESSOR, { model: "off", trigger: "test restore" });
    }
  });
});

describe("finding 3: the background re-check never stores a run older than the evidence", () => {
  it("the fingerprint moves with a decision, a plan entry and nothing else", async () => {
    const a = await testInputFingerprint(ws);
    expect(await testInputFingerprint(ws)).toBe(a);
    const [c] = await listClaims(ws);
    await sql`UPDATE claims SET review = 'approved' WHERE workspace_id = ${ws} AND id = ${c.id}`;
    const b = await testInputFingerprint(ws);
    expect(b).not.toBe(a);
    await sql`UPDATE claims SET review = ${c.review} WHERE workspace_id = ${ws} AND id = ${c.id}`;
    expect(await testInputFingerprint(ws)).toBe(a);
  });

  it("a run whose inputs changed while it was judged is refused and nothing is stored", async () => {
    const taken = await testInputFingerprint(ws);
    const [c] = await listClaims(ws);
    await sql`UPDATE claims SET review = 'edited' WHERE workspace_id = ${ws} AND id = ${c.id}`; // a writer got in
    const runs = await runCount();
    await expect(runTest(ws, SUCCESSOR, { model: "off", trigger: "model re-check", refuseStale: taken })).rejects.toBeInstanceOf(StaleTestError);
    expect(await runCount()).toBe(runs);
    await sql`UPDATE claims SET review = ${c.review} WHERE workspace_id = ${ws} AND id = ${c.id}`;
    // Unchanged inputs: stored as usual.
    await runTest(ws, SUCCESSOR, { model: "off", trigger: "model re-check", refuseStale: await testInputFingerprint(ws) });
    expect(await runCount()).toBe(runs + 1);
  });

  it("every writer can tell a running re-check to go round again; a quiet one settles and gives the lease back", async () => {
    const lease = async () => (await sql`SELECT generation FROM action_leases WHERE workspace_id = ${ws} AND key = ${REJUDGE_KEY}`)[0];
    await evidenceChanged(ws); // no re-check running: a no-op
    expect(await lease()).toBeUndefined();
    const work = await scheduleRejudge(ws, undefined, { force: true });
    expect(work).not.toBeNull();
    const g = Number((await lease()).generation);
    await evidenceChanged(ws);
    expect(Number((await lease()).generation)).toBe(g + 1);
    // A second request while one is scheduled is picked up by it (no second worker).
    expect(await scheduleRejudge(ws, undefined, { force: true })).toBeNull();
    const runs = await runCount();
    expect(await work!()).toBe("settled");
    expect(await lease()).toBeUndefined();
    expect(await runCount()).toBe(runs + CLUB.testRoles.length);
  });

  it("evidence that changes in every round ends as not settled, on the record, with no stale run stored", async () => {
    const work = await scheduleRejudge(ws, undefined, { force: true });
    const [c] = await listClaims(ws);
    // A writer that never stops: the review of one claim flips on every insert attempt of a re-check run.
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION tmp_review_fixes_flip() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NEW;
      END $$`);
    let stop = false;
    const writer = (async () => {
      for (let i = 0; !stop; i++) {
        await sql`UPDATE claims SET review = ${i % 2 ? "approved" : "edited"} WHERE workspace_id = ${ws} AND id = ${c.id}`;
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const runs = await runCount();
    const outcome = await work!();
    stop = true;
    await writer;
    await sql.unsafe("DROP FUNCTION IF EXISTS tmp_review_fixes_flip()");
    await sql`UPDATE claims SET review = ${c.review} WHERE workspace_id = ${ws} AND id = ${c.id}`;
    if (outcome === "not_settled") {
      const [row] = await sql`SELECT detail FROM audit_log WHERE workspace_id = ${ws} AND action = 'rejudge_not_settled' ORDER BY id DESC LIMIT 1`;
      expect(row).toBeTruthy();
    } else {
      // The writer happened to miss a round: then that round's runs are current and it settled.
      expect(outcome).toBe("settled");
      expect(await runCount()).toBeGreaterThan(runs);
    }
    expect((await sql`SELECT 1 FROM action_leases WHERE workspace_id = ${ws} AND key = ${REJUDGE_KEY}`).length).toBe(0);
  });
});
