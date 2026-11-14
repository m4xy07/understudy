// Lacuna against the local database on the demo pack. The demo sources are ingested by Tether;
// claims are the planted ones from ground_truth.json (as a perfect extractor would produce them).
// The stand-in runs deterministically here (model "off") so the numbers are reproducible.
// Needs a migrated database (pnpm db:up && pnpm db:migrate).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { getLatestTestRun, listClaims, listResponsibilities } from "@/lib/db/queries";
import {
  answerQuestion, buildInventory, buildQuestions, claimMeta, confirmInventory, listBlockingGaps, listQuestions,
  releaseInfo, runTest, savePlanItem, type InventoryResult,
} from "@/lib/lacuna";
import type { Responsibility, RoleKey, TestRun } from "@/lib/types";
import { loadGroundTruth, seedGroundTruthClaims } from "./gt-seed";
import { CLUB_ID } from "../helpers/club";

process.env.LACUNA_MODEL = "off"; // re-tests after answers stay deterministic and fast
const sql = db();
const gt = loadGroundTruth();
let ws = "";
let inv: InventoryResult;
let resps: Responsibility[] = [];
let first: TestRun;
const log: string[] = [];

/** Ground-truth key (R01..) -> stored responsibility, matched by entity. */
function byGt(key: string): Responsibility | undefined {
  const g = gt.responsibilities.find((r) => r.key === key)!;
  return resps.find((r) => g.entities.some((e) => r.entities.includes(e)));
}

function fmt(s: { b: number; c: number; k: number | null }): string {
  return `B ${s.b} · C ${Math.round(s.c * 100)}% · K ${s.k === null ? "n/a" : `${Math.round(s.k * 100)}%`}`;
}

beforeAll(async () => {
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  const seeded = await seedGroundTruthClaims(ws);
  log.push(`seeded ${seeded.seeded} planted claims; unmatched: ${seeded.unmatched.join(", ") || "none"}`);
  inv = await buildInventory(ws);
  resps = await listResponsibilities(ws);
  first = await runTest(ws, "tech_lead", { model: "off", trigger: "test" });
  await runTest(ws, "new_member", { model: "off", trigger: "test" });
}, 180_000);

afterAll(async () => {
  console.log(`\n[lacuna integration] workspace ${ws}\n${log.join("\n")}\n`);
  if (ws && !process.env.LACUNA_KEEP_WS) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("inventory on the demo pack", () => {
  it("finds the ten ground-truth responsibilities by entity, with kinds and origins", () => {
    log.push(`leaver person ids: ${inv.leaverIds.join(", ")}`);
    log.push(`dropped footprint: ${inv.dropped.map((d) => `${d.entityKey} (${d.reason})`).join("; ") || "none"}`);
    log.push("inventory:");
    for (const r of resps) log.push(`  ${r.key} ${r.title} [${r.kind}] origin=${r.origin} entities=${r.entities.join(",")} due=${r.dueDate ?? "-"} :: ${r.originDetail}`);
    const mismatches: string[] = [];
    for (const g of gt.responsibilities) {
      const r = byGt(g.key);
      if (!r) { mismatches.push(`${g.key} ${g.title}: not found`); continue; }
      if (r.kind !== g.kind) mismatches.push(`${g.key}: kind ${r.kind} (ground truth ${g.kind})`);
      if (r.origin !== g.origin) mismatches.push(`${g.key}: origin ${r.origin} (ground truth ${g.origin}) — ${r.originDetail}`);
      for (const e of g.entities) if (!r.entities.includes(e)) mismatches.push(`${g.key}: missing entity ${e}`);
    }
    const extra = resps.filter((r) => !gt.responsibilities.some((g) => g.entities.some((e) => r.entities.includes(e))));
    for (const r of extra) mismatches.push(`extra: ${r.key} ${r.title} (${r.originDetail})`);
    log.push(`inventory vs ground truth: ${mismatches.length ? `\n  ${mismatches.join("\n  ")}` : "all ten match"}`);
    for (const g of gt.responsibilities) expect(byGt(g.key), g.key).toBeDefined();
    for (const g of gt.responsibilities) expect(byGt(g.key)!.kind, g.key).toBe(g.kind);
    expect(resps.find((r) => r.entities.includes("controller-board"))).toBeUndefined();
    expect(byGt("R01")!.entities).toEqual(expect.arrayContaining(["firmware-deploy", "firmware-rollback"]));
  });

  it("only the president confirms the inventory", async () => {
    expect((await confirmInventory(ws, "tech_lead")).ok).toBe(false);
    expect((await confirmInventory(ws, "leaver")).ok).toBe(false);
    const ok = await confirmInventory(ws, "president");
    expect(ok.ok).toBe(true);
    expect((await listResponsibilities(ws)).every((r) => r.confirmed)).toBe(true);
    const [row] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = ${ws} AND action = 'confirm_inventory'`;
    expect(row.n).toBe(1);
  });
});

describe("successor test", () => {
  it("reports B, C, K for the tech lead and the blocking gaps of the ground truth", async () => {
    log.push(`tech_lead before answers: ${fmt(first.scores)} (provisional ${first.provisional})`);
    const gaps = await listBlockingGaps(ws, "tech_lead");
    log.push(`tech_lead blocking gaps (${gaps.length}):`);
    for (const g of gaps) log.push(`  ${g.responsibilityKey} ${g.responsibilityTitle} · ${g.checkKey} · ${g.coverage}`);
    const expected = gt.gaps.filter((g) => g.blocking);
    const diffs: string[] = [];
    for (const e of expected) {
      const r = byGt(e.responsibility);
      const res = first.results.find((x) => x.responsibilityId === r?.id && x.checkKey === e.checkKey);
      if (res?.coverage !== e.coverage) diffs.push(`${e.responsibility}.${e.checkKey}: got ${res?.coverage ?? "none"}, ground truth ${e.coverage}`);
    }
    for (const g of gaps) {
      const key = gt.responsibilities.find((x) => x.entities.some((e) => resps.find((r) => r.id === g.responsibilityId)?.entities.includes(e)))?.key;
      if (!expected.some((e) => e.responsibility === key && e.checkKey === g.checkKey)) diffs.push(`unexpected gap ${key}.${g.checkKey} (${g.coverage})`);
    }
    for (const e of gt.gaps.filter((g) => !g.blocking)) {
      const r = byGt(e.responsibility);
      const res = first.results.find((x) => x.responsibilityId === r?.id && x.checkKey === e.checkKey);
      if (res?.coverage !== e.coverage) diffs.push(`(non-blocking) ${e.responsibility}.${e.checkKey}: got ${res?.coverage ?? "none"}, ground truth ${e.coverage}`);
    }
    log.push(`gaps vs ground truth: ${diffs.length ? `\n  ${diffs.join("\n  ")}` : "all match"}`);
    expect(first.provisional).toBe(true);
    expect(first.scores.b).toBe(gaps.length);
    expect(gaps.length).toBe(gt.expectedTechLeadBlockingGaps);
  });

  it("decides Restricted for the tech lead from claim_meta(), without reading the rows", async () => {
    // claim_meta works inside withRole (us_reader) and returns metadata only.
    const meta = await claimMeta(ws, "tech_lead");
    const [cols] = await sql`SELECT * FROM claim_meta(${ws}::uuid) LIMIT 1`;
    expect(Object.keys(cols).sort()).toEqual(["attribute", "entity", "id", "role_set", "state", "trust"]);
    const visible = new Set((await listClaims(ws, { role: "tech_lead" })).map((c) => c.id));
    const hidden = [...meta.entries()].filter(([id]) => !visible.has(id));
    expect(hidden.length).toBeGreaterThan(0);
    for (const [, m] of hidden) expect(m.roleSet).not.toContain("tech_lead");

    for (const rc of gt.restrictedChecks.filter((x) => !x.visibleTo.includes("tech_lead"))) {
      const r = byGt(rc.responsibility)!;
      const res = first.results.find((x) => x.responsibilityId === r.id && x.checkKey === rc.checkKey);
      expect(res?.coverage, `${rc.responsibility}.${rc.checkKey}`).toBe("restricted");
      expect(res?.claimIds).toEqual([]);
    }
    // ...and the same checks are not restricted for a role that may see them.
    const president = await runTest(ws, "president", { model: "off", trigger: "test" });
    for (const rc of gt.restrictedChecks.filter((x) => !x.visibleTo.includes("tech_lead"))) {
      const r = byGt(rc.responsibility)!;
      const res = president.results.find((x) => x.responsibilityId === r.id && x.checkKey === rc.checkKey);
      expect(res?.coverage).not.toBe("restricted");
    }
  });

  it("a credential name alone does not satisfy the credential owner check", () => {
    const r = byGt("R01")!;
    const res = first.results.find((x) => x.responsibilityId === r.id && x.checkKey === "credential_owner");
    expect(res?.coverage).toBe("missing");
  });
});

describe("questions, answers and the plan", () => {
  it("asks at most ten questions, ranked, never about restricted checks", async () => {
    const qs = await buildQuestions(ws);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.length).toBeLessThanOrEqual(10);
    const restricted = new Set(first.results.filter((r) => r.coverage === "restricted").map((r) => `${r.responsibilityId}|${r.checkKey}`));
    for (const q of qs) expect(restricted.has(`${q.responsibilityId}|${q.checkKey}`)).toBe(false);
    log.push("questions:");
    for (const q of await listQuestions(ws)) {
      const r = resps.find((x) => x.id === q.responsibilityId)!;
      log.push(`  ${q.rank}. [${r.key} ${q.checkKey} ${q.gapType} w${q.weight} u${q.urgency} score ${q.score}] ${q.text}`);
    }
  });

  it("only the leaver can answer", async () => {
    const [q] = (await listQuestions(ws)).filter((x) => !x.answeredClaimId);
    for (const role of ["president", "tech_lead", "new_member", "treasurer"] as RoleKey[]) {
      const res = await answerQuestion(ws, q.id, "Some answer", role);
      expect(res.ok).toBe(false);
    }
    expect((await listQuestions(ws)).find((x) => x.id === q.id)?.answeredClaimId).toBeNull();
  });

  it("a leaver answer raises C, not K; narrowing never widens", async () => {
    const qs = (await listQuestions(ws)).filter((x) => !x.answeredClaimId);
    const q = qs[0];
    const before = (await getLatestTestRun(ws, "tech_lead"))!.scores;
    const res = await answerQuestion(ws, q.id, "Arjun Mehta holds the OTA password; the president can grant access.", "leaver", ["tech_lead", "new_member"]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.after.c).toBeGreaterThan(before.c);
    if (before.k !== null && res.after.k !== null) expect(res.after.k).toBeLessThanOrEqual(before.k);
    const claim = (await listClaims(ws)).find((c) => c.id === res.claimId)!;
    expect(claim.trust).toBe("leaver_said");
    expect(claim.origin).toBe("leaver_answer");
    expect(claim.roleSet.sort()).toEqual(["leaver", "new_member", "president", "tech_lead"]);
    // The answer is a masked interview segment.
    const [seg] = await sql`SELECT * FROM segments WHERE workspace_id = ${ws} AND id = ${claim.citations[0].segmentId}`;
    expect(seg.source_kind).toBe("interview");
    expect(seg.kind).toBe("answer");
    const [ev] = await sql`SELECT * FROM claim_events WHERE workspace_id = ${ws} AND claim_id = ${res.claimId}`;
    expect(ev.actor).toBe("leaver");
    expect((await listQuestions(ws)).find((x) => x.id === q.id)?.scoreDelta).toMatch(/^B \d+/);

    // Narrowing to a role outside the default set never adds it; a narrowed answer never widens.
    const q2 = (await listQuestions(ws)).filter((x) => !x.answeredClaimId)[0];
    const res2 = await answerQuestion(ws, q2.id, "Email me at priya@example.org; ask Mr. Pawar.", "leaver", ["treasurer"]);
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    const c2 = (await listClaims(ws)).find((c) => c.id === res2.claimId)!;
    expect(c2.roleSet.sort()).toEqual(["leaver", "president", "treasurer"]);
    expect(c2.statement).not.toContain("priya@example.org");
    expect(c2.statement).toMatch(/\[CONTACT:c-\d+\]/);
    const visibleToLead = (await listClaims(ws, { role: "tech_lead" })).some((c) => c.id === res2.claimId);
    expect(visibleToLead).toBe(false);
  });

  it("answering every question with ground-truth answers lowers B (demo numbers)", async () => {
    const answers: Record<string, string> = {
      credential_owner: "Arjun Mehta holds the OTA password in the club password manager; the president grants access.",
      next_due_date: "The next-term lab booking must reach Mr. Pawar by 1 Dec 2026; the next late-access request is due 19 Nov 2026.",
      next_concrete_step: "Add the confirmation email to register.html, test it with a dummy team, then switch the form live.",
      owner: "Rohan Kulkarni owns drive team selection after I leave.",
      deadline: "Trials are on 29 Nov 2026, the #events date is right; Dev's 22 Nov was the old plan.",
      how_to_do_it: "Message Mr. Pawar on WhatsApp by Wednesday, then sign the late-access register at security.",
      open_commitments: "Vertex Motors expects the logo on the robot shell and a thank-you post after the competition.",
      consequence_if_missed: "If it lapses the registration form goes offline, like last year.",
    };
    const start = (await getLatestTestRun(ws, "tech_lead"))!.scores;
    let guard = 0;
    for (;;) {
      const open = (await listQuestions(ws)).filter((x) => !x.answeredClaimId);
      if (!open.length || guard++ > 12) break;
      const q = open[0];
      const text = answers[q.checkKey] ?? `For this, the record is right: see my notes (${q.checkKey}).`;
      const res = await answerQuestion(ws, q.id, text, "leaver");
      expect(res.ok).toBe(true);
    }
    const end = (await getLatestTestRun(ws, "tech_lead"))!.scores;
    log.push(`tech_lead after answering all questions: ${fmt(start)} → ${fmt(end)}`);
    for (const q of (await listQuestions(ws)).filter((x) => x.answeredClaimId)) {
      const r = resps.find((x) => x.id === q.responsibilityId)!;
      log.push(`  ${r.key} ${q.checkKey}: ${q.scoreDelta}`);
    }
    expect(end.b).toBeLessThan(start.b);
    expect(end.c).toBeGreaterThan(start.c);
    // K never rises from leaver answers.
    if (start.k !== null && end.k !== null) expect(end.k).toBeLessThanOrEqual(start.k);
    const gaps = await listBlockingGaps(ws, "tech_lead");
    log.push(`remaining tech_lead blocking gaps: ${gaps.map((g) => `${g.responsibilityKey}.${g.checkKey} (${g.coverage})`).join(", ")}`);
  }, 120_000);

  it("only the president saves plan items; a complete plan releases with open gaps", async () => {
    const gaps = await listBlockingGaps(ws, "tech_lead");
    expect(gaps.length).toBeGreaterThan(0);
    const g = gaps[0];
    const item = { responsibilityId: g.responsibilityId, checkKey: g.checkKey, owner: "Incoming tech lead", dueDate: "2026-11-30", riskNote: "Known gap." };
    for (const role of ["leaver", "tech_lead", "treasurer", "new_member"] as RoleKey[]) {
      expect((await savePlanItem(ws, item, role)).ok).toBe(false);
    }
    expect((await releaseInfo(ws)).canApprove).toBe(false);
    for (const x of gaps) {
      const res = await savePlanItem(ws, { ...item, responsibilityId: x.responsibilityId, checkKey: x.checkKey }, "president");
      expect(res.ok).toBe(true);
    }
    const rel = await releaseInfo(ws);
    log.push(`release: ${rel.label} (B ${rel.scores?.b})`);
    expect(rel.canApprove).toBe(true);
    expect(rel.label).toMatch(/^Released with \d+ open blocking gaps?$/);
  });
});
