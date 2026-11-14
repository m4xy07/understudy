// The three Round 3 improvements working together, against the local database:
//   * sensitive text typed into an open question (a leaver answer, a neighbour answer, a successor
//     finding) is limited at insert, by the same rules as an ingested message;
//   * T29 (spec 02 section 14): graph and neighbour rules. A neighbour is never asked about, or
//     shown, content limited away from their role; a neighbour without access sees nothing; the
//     graph of the role that sees least has no edge that exists only through limited segments;
//   * the leak grid's recovery and living-handover columns are real and stay green;
//   * the lab pack: its sensitivity map limits the three planted placeholders, and recovery and
//     First weeks work on a lab workspace.
// The demo sources are ingested by Tether (the classifier runs before the first write); the club
// claims are the planted ones (as a perfect extractor would produce them); the stand-in runs
// deterministically. Needs a migrated, seeded database.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { getLatestTestRun, listResponsibilities } from "@/lib/db/queries";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { executeRun, startRun } from "@/lib/pipeline/run";
import { rerunRules } from "@/lib/attest";
import {
  answerAsNeighbour, answerQuestion, buildInventory, buildQuestions, listBlockingGaps, listLadder, listQuestions,
  questionsForRole, recoveryState, recoverySurfaces, runTest, savePlanItem, setLeaverUnreachable,
} from "@/lib/lacuna";
import { approveSnapshot, runLeakCheck } from "@/lib/relay";
import { scanForCanaries } from "@/lib/relay/core/canary";
import { exampleFinding, firstWeeks, listFindings, listOpenGaps, recordFinding } from "@/lib/relay/living";
import { EXTERNAL_SURFACES, livingTexts, recoveryColumns } from "@/lib/relay/surface-sources";
import { getPack } from "@/lib/pack";
import { buildGraph, toGraphSegment, type GraphSegment } from "@/lib/tether/graph";
import type { RoleKey, Segment, SourceKind } from "@/lib/types";
import { seedGroundTruthClaims } from "../lacuna/gt-seed";
import { CLUB, CLUB_DEMO_DIR, CLUB_ID } from "../helpers/club";

process.env.LACUNA_MODEL = "off";
const sql = db();
const ROLES = CLUB.roleOrder as RoleKey[];
const APPROVER = CLUB.approverRole as RoleKey;
const SUCCESSOR = CLUB.successorRole as RoleKey;
const LEAVER = CLUB.leaverRole as RoleKey;
const LEAST = CLUB.restrictedAudienceRoles[0] as RoleKey; // the role that sees least
const SENS = CLUB.sensitivity as Record<string, RoleKey[]>;
const GT = JSON.parse(fs.readFileSync(path.join(process.cwd(), CLUB_DEMO_DIR, "ground_truth.json"), "utf8")) as {
  restricted: { token: string; roleSet: RoleKey[] }[];
  sensitive: { id: string; case: string; containsText: string; expectedRoles: RoleKey[] }[];
};
const subset = (a: readonly string[], b: readonly string[]) => a.every((x) => b.includes(x));

// Typed texts that the classifier's rules limit (the same wording families as the planted cases).
const HEALTH = "Ask Dev after 1 Dec: he is having knee surgery on 17 Nov 2026 and will be out for two weeks.";
const FINANCE = "Kabir, you still owe the Rs 1,500 season membership fee from August, so his reimbursement is on hold.";
const HR = "Arjun insulted my code in last night's review with everyone watching, this is harassment now.";
const PLAIN = "It is in the shared drive under Handover, in the folder for this season.";

let ws = "";
const purge = async (id: string) => {
  if (!id) return;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${id}`;
  });
};
const headSegment = async (w: string, id: string) =>
  (await sql`SELECT * FROM segments WHERE workspace_id = ${w} AND id = ${id} ORDER BY version DESC LIMIT 1`)[0];
const claimRow = async (w: string, id: string) => (await sql`SELECT * FROM claims WHERE workspace_id = ${w} AND id = ${id}`)[0];
const canRead = async (w: string, role: RoleKey, claimId: string) =>
  (await withRole(w, role, (tx) => tx`SELECT 1 FROM claims WHERE workspace_id = ${w} AND id = ${claimId}`)).length > 0;
const segmentOfClaim = async (w: string, claimId: string) => {
  const c = await claimRow(w, claimId);
  const citations = (typeof c.citations === "string" ? JSON.parse(c.citations) : c.citations) as { segmentId: string }[];
  return headSegment(w, citations[0].segmentId);
};

beforeAll(async () => {
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  await seedGroundTruthClaims(ws);
  await buildInventory(ws);
  await rerunRules(ws, "system");
  for (const role of [SUCCESSOR, ...CLUB.testRoles.filter((r) => r !== SUCCESSOR)]) await runTest(ws, role, { model: "off", trigger: "test" });
  await buildQuestions(ws);
}, 240_000);

afterAll(async () => {
  await purge(ws);
  await sql.end();
});

describe("sensitive text typed into the app is limited at insert", () => {
  it("a leaver answer with health content is stored for the health roles only; a plain answer is not limited", async () => {
    const open = (await listQuestions(ws)).filter((q) => !q.answeredClaimId);
    expect(open.length).toBeGreaterThan(2);

    const res = await answerQuestion(ws, open[0].id, HEALTH, LEAVER);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.limited).toMatch(/sensitive content/);
    const claim = await claimRow(ws, res.claimId);
    expect(subset(claim.role_set as RoleKey[], SENS.health)).toBe(true);
    const seg = await segmentOfClaim(ws, res.claimId);
    expect(seg.role_set).toEqual(claim.role_set);
    expect(seg.sensitivity).toContain("health");
    expect(seg.sensitivity_stage).toBe("rule");
    expect((seg.role_set_original as RoleKey[]).length).toBeGreaterThan((seg.role_set as RoleKey[]).length);
    // Enforced by RLS from the first moment: a role outside the health roles reads neither row.
    for (const role of ROLES) {
      const may = SENS.health.includes(role);
      expect(await canRead(ws, role, res.claimId), role).toBe(may);
      const segs = await withRole(ws, role, (tx) => tx`SELECT 1 FROM segments WHERE workspace_id = ${ws} AND id = ${String(seg.id)}`);
      expect(segs.length > 0, role).toBe(may);
    }
    // The re-test ran as the successor without the hidden answer: it is not cited there.
    const run = (await getLatestTestRun(ws, SUCCESSOR))!;
    expect(run.results.some((r) => r.claimIds.includes(res.claimId))).toBe(false);

    const plain = await answerQuestion(ws, open[1].id, PLAIN, LEAVER);
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.limited ?? null).toBeNull();
    const plainSeg = await segmentOfClaim(ws, plain.claimId);
    expect(plainSeg.sensitivity).toEqual([]);
    expect(plainSeg.role_set_original).toBeNull();
    expect(await canRead(ws, SUCCESSOR, plain.claimId)).toBe(true);
  });

  it("a successor finding with finance content is limited to the finance roles, so it waits for the approver unseen by the others", async () => {
    await sql`UPDATE claims SET review = 'approved' WHERE workspace_id = ${ws} AND state IN ('active', 'conflicting')`;
    for (const g of await listBlockingGaps(ws)) {
      const r = await savePlanItem(ws, { responsibilityId: g.responsibilityId, checkKey: g.checkKey, owner: "Incoming tech lead", dueDate: "2026-11-30", riskNote: "Known gap; checked weekly." }, APPROVER);
      expect(r.ok).toBe(true);
    }
    const snap = await approveSnapshot(ws, APPROVER);
    expect(snap.ok, snap.ok ? "" : snap.error).toBe(true);

    const gap = (await listOpenGaps(ws, SUCCESSOR)).find((g) => g.canRecord && !g.needsDate)!;
    expect(gap, "an open text gap").toBeTruthy();
    const res = await recordFinding(ws, SUCCESSOR, {
      responsibilityId: gap.responsibilityId, checkKey: gap.checkKey, answer: "Ask the treasurer before spending", note: FINANCE,
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.limited).toMatch(/sensitive content/);
    expect(subset(res.roleSet, SENS.finance)).toBe(true);
    const [f] = await sql`SELECT * FROM findings WHERE workspace_id = ${ws} AND id = ${res.findingId}`;
    expect(f.role_set).toEqual(res.roleSet);
    const seg = await headSegment(ws, String(f.segment_id));
    expect(seg.role_set).toEqual(res.roleSet);
    expect(seg.sensitivity).toContain("finance");
    expect((await claimRow(ws, res.claimId)).role_set).toEqual(res.roleSet);
    for (const role of ROLES) {
      const sees = (await listFindings(ws, role)).some((x) => x.claimId === res.claimId);
      expect(sees, role).toBe(res.roleSet.includes(role));
      if (!res.roleSet.includes(role)) expect((await livingTexts(ws, role)).join("\n")).not.toContain("season membership fee");
    }
    expect((await listFindings(ws, APPROVER)).some((x) => x.claimId === res.claimId)).toBe(true);
  });

  it("a neighbour answer with a complaint about a person is limited to the HR roles", async () => {
    const on = await setLeaverUnreachable(ws, true, APPROVER, "Wiring test");
    expect(on.ok, on.ok ? "" : on.error).toBe(true);
    const [step] = await sql`
      SELECT * FROM recovery_steps WHERE workspace_id = ${ws} AND rung = 1 AND kind = 'neighbour' AND status = 'asked' ORDER BY id LIMIT 1`;
    expect(step, "a neighbour who is asked").toBeTruthy();
    const res = await answerAsNeighbour(ws, String(step.id), HR, String(step.target_role));
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok || res.declined) return;
    expect(res.limited).toMatch(/sensitive content/);
    const claim = await claimRow(ws, res.claimId);
    expect(subset(claim.role_set as RoleKey[], SENS.hr)).toBe(true);
    const seg = await segmentOfClaim(ws, res.claimId);
    expect(seg.role_set).toEqual(claim.role_set);
    expect(seg.sensitivity).toContain("hr");
    for (const role of ROLES.filter((r) => !SENS.hr.includes(r))) {
      expect(await canRead(ws, role, res.claimId), role).toBe(false);
      const shown = (await recoverySurfaces(ws, role)).map((s) => s.text).join("\n");
      expect(shown, role).not.toContain("harassment");
    }
  });
});

describe("T29: graph and neighbour rules with recovery on", () => {
  const caseC = GT.sensitive.filter((x) => x.case === "C");

  it("case C is limited at ingest, and Arjun (tech lead) is never asked about it or shown it", async () => {
    expect((await recoveryState(ws)).on).toBe(true);
    expect(caseC.length).toBeGreaterThan(0);
    for (const x of caseC) {
      const [seg] = await sql`
        SELECT DISTINCT ON (id) id, role_set, role_set_original FROM segments
        WHERE workspace_id = ${ws} AND position(${x.containsText} in text) > 0 ORDER BY id, version DESC`;
      expect(seg, x.id).toBeTruthy();
      expect(subset(seg.role_set as RoleKey[], x.expectedRoles), x.id).toBe(true);
      expect(seg.role_set as RoleKey[]).not.toContain(SUCCESSOR);
    }
    const words = [...caseC.map((x) => x.containsText), "harassment", "dismissing my firmware", "insulted my code"];
    const rows = await sql`SELECT * FROM recovery_steps WHERE workspace_id = ${ws}`;
    for (const r of rows.filter((x) => (x.role_set as RoleKey[]).includes(SUCCESSOR) || x.target_role === SUCCESSOR)) {
      const text = [r.question_text, r.reason, JSON.stringify(r.detail)].join(" ");
      for (const w of words) expect(text).not.toContain(w);
    }
    const asked = await questionsForRole(ws, SUCCESSOR);
    for (const q of asked) for (const w of words) expect(`${q.text} ${q.reason}`).not.toContain(w);
    const shown = (await recoveryColumns(ws, SUCCESSOR)).map((s) => s.text).join("\n");
    for (const w of words) expect(shown).not.toContain(w);
  });

  it("no role is shown, in any recovery surface, a sensitive message or a token outside its permissions", async () => {
    const allTokens = GT.restricted.map((t) => t.token);
    for (const role of ROLES) {
      const surfaces = await recoveryColumns(ws, role);
      const text = surfaces.map((s) => s.text).join("\n");
      for (const x of GT.sensitive.filter((s) => !s.expectedRoles.includes(role))) expect(text, `${role} ${x.id}`).not.toContain(x.containsText);
      const allowed = new Set(GT.restricted.filter((t) => t.roleSet.includes(role)).map((t) => t.token));
      expect(scanForCanaries(surfaces, allowed, allTokens), role).toEqual([]);
    }
    // The approver's ladder really has content, so the checks above read something.
    expect((await recoveryColumns(ws, APPROVER)).map((s) => s.text).join("").length).toBeGreaterThan(200);
  });

  it("a neighbour without access sees nothing: the skipped row is hidden from their role and no question waits for them", async () => {
    const skipped = await sql`SELECT * FROM recovery_steps WHERE workspace_id = ${ws} AND status = 'skipped_no_access'`;
    expect(skipped.length, "the demo plants skips").toBeGreaterThan(0);
    for (const s of skipped) {
      const role = String(s.target_role) as RoleKey;
      expect(s.role_set as RoleKey[]).not.toContain(role);
      expect(s.question_text).toBeNull();
      const readable = await withRole(ws, role, (tx) => tx`SELECT 1 FROM recovery_steps WHERE workspace_id = ${ws} AND id = ${String(s.id)}`);
      expect(readable).toHaveLength(0);
      expect((await questionsForRole(ws, role)).filter((q) => q.stepId === String(s.id))).toEqual([]);
      const gap = (await listLadder(ws, role)).find((g) => g.responsibilityId === String(s.responsibility_id) && g.checkKey === String(s.check_key));
      expect(gap?.rungs[1].some((x) => x.id === String(s.id)) ?? false).toBe(false);
    }
  });

  it(`the graph for ${LEAST} has no edge that exists only through limited segments`, async () => {
    // What the role may read, straight from RLS (head versions only).
    const visible = new Set((await withRole(ws, LEAST, (tx) => tx`SELECT id FROM segments WHERE workspace_id = ${ws}`)).map((r) => String(r.id)));
    const head = await sql`
      SELECT DISTINCT ON (id) id, source_kind, kind, ts, author_id, thread, position, role_set, role_set_original, meta
      FROM segments WHERE workspace_id = ${ws} AND kind = ANY(${["message", "commit", "file", "task", "note", "event"]}::text[])
      ORDER BY id, version DESC`;
    const limited = new Set(head
      .filter((r) => Array.isArray(r.role_set_original) && (r.role_set_original as RoleKey[]).includes(LEAST) && !(r.role_set as RoleKey[]).includes(LEAST))
      .map((r) => String(r.id)));
    expect(limited.size, "messages limited away from the role at ingest").toBeGreaterThan(0);
    for (const id of limited) expect(visible.has(id)).toBe(false);

    const toSeg = (r: Record<string, unknown>): GraphSegment => toGraphSegment({
      id: String(r.id), sourceKind: r.source_kind as SourceKind, kind: r.kind as Segment["kind"],
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts), authorId: (r.author_id as string | null) ?? null,
      thread: String(r.thread), position: Number(r.position ?? 0), roleSet: (r.role_set as RoleKey[]) ?? [],
      meta: (typeof r.meta === "string" ? JSON.parse(r.meta) : r.meta) as Record<string, unknown>,
    });
    const opts = { now: new Date(CLUB.demo!.today).toISOString(), windowMonths: CLUB.footprint.windowMonths };
    const all = head.map(toSeg);
    // The whole record has interactions that run through a limited message (the replies to it).
    const full = buildGraph(all, opts);
    const through = full.instances.filter((i) => limited.has(i.segA) || limited.has(i.segB));
    expect(through.length, "edges that exist through limited segments").toBeGreaterThan(0);
    // The graph the ladder builds for the role (segments whose role set holds it) has none of them,
    // and it is built from exactly the segments RLS lets the role read.
    const own = all.filter((s) => s.roleSet.includes(LEAST));
    expect(own.every((s) => visible.has(s.id))).toBe(true);
    const roleGraph = buildGraph(own, opts);
    expect(roleGraph.instances.filter((i) => limited.has(i.segA) || limited.has(i.segB))).toEqual([]);
    for (const e of roleGraph.edges) expect(e.segmentIds.some((id) => limited.has(id))).toBe(false);
    // A pair that interacts only through limited messages has no edge at all for the role.
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const rolePairs = new Set(roleGraph.instances.map((i) => pairKey(i.a, i.b)));
    const onlyLimited = new Set(through.map((i) => pairKey(i.a, i.b)));
    for (const i of full.instances) if (!limited.has(i.segA) && !limited.has(i.segB) && own.some((s) => s.id === i.segA) && own.some((s) => s.id === i.segB)) onlyLimited.delete(pairKey(i.a, i.b));
    for (const p of onlyLimited) expect(rolePairs.has(p), p).toBe(false);

    // Every neighbour row the role can read is one its own role set allows, with a reason made of counts only.
    for (const g of await listLadder(ws, LEAST)) {
      for (const s of g.rungs[1].filter((x) => x.kind === "neighbour")) {
        for (const x of GT.sensitive) expect(`${s.reason} ${s.questionText ?? ""}`).not.toContain(x.containsText);
      }
    }
  });

  it("the leak grid's recovery and living-handover columns are built, have content and stay green", async () => {
    expect(typeof EXTERNAL_SURFACES.recoverySurfaces).toBe("function");
    expect(typeof EXTERNAL_SURFACES.changeTexts).toBe("function");
    const r = await runLeakCheck(ws, { judge: "off" });
    expect(r.surfaces.filter((s) => !s.built)).toEqual([]);
    expect(r.cells.filter((c) => c.leaks > 0).map((c) => `${c.role}/${c.surface}/${c.row}`)).toEqual([]);
    expect(r.allPass).toBe(true);
    const cell = (role: RoleKey, surface: string) => r.cells.find((c) => c.role === role && c.surface === surface && c.row === "token")!;
    expect(cell(APPROVER, "graph").texts).toBeGreaterThan(0);
    for (const role of ROLES) expect(cell(role, "changes").texts, role).toBeGreaterThan(0);
    expect(RECOVERY_KEYS.some((k) => cell(LEAST, k).built)).toBe(true);
  });
});

const RECOVERY_KEYS = ["graph", "neighbour_questions", "traces", "ranked_options"];

describe("the lab pack: sensitivity map, recovery and First weeks", () => {
  const LAB = getPack("lab");
  const LAB_GT = JSON.parse(fs.readFileSync(path.join(process.cwd(), LAB.demo!.dataDir, "ground_truth.json"), "utf8")) as {
    sensitivityPlaceholders: { contains: string; proposedCategory: string }[];
  };
  let lab = "";

  beforeAll(async () => {
    lab = (await createDemoWorkspace("lab")).id;
    const { runId } = await startRun(lab);
    expect((await executeRun(lab, runId))?.status).toBe("done");
  }, 240_000);
  afterAll(() => purge(lab));

  it("the pack maps every category to roles of the lab, always including the approver", () => {
    const map = LAB.sensitivity as Record<string, RoleKey[]>;
    for (const c of ["finance", "hr", "health"]) {
      expect(map[c]?.length, c).toBeGreaterThan(0);
      expect(subset(map[c], LAB.roleOrder), c).toBe(true);
      expect(map[c]).toContain(LAB.approverRole);
      expect(map[c].length).toBeLessThan(LAB.roleOrder.length);
    }
  });

  it("the three planted placeholders are limited at ingest to the roles of their category", async () => {
    expect(LAB_GT.sensitivityPlaceholders).toHaveLength(3);
    const map = LAB.sensitivity as Record<string, RoleKey[]>;
    for (const p of LAB_GT.sensitivityPlaceholders) {
      const [seg] = await sql`
        SELECT DISTINCT ON (id) id, role_set, role_set_original, sensitivity, sensitivity_stage FROM segments
        WHERE workspace_id = ${lab} AND position(${p.contains} in text) > 0 ORDER BY id, version DESC`;
      expect(seg, p.contains).toBeTruthy();
      expect(seg.role_set_original, p.contains).not.toBeNull();
      const roles = seg.role_set as RoleKey[];
      expect(roles.length).toBeLessThan((seg.role_set_original as RoleKey[]).length);
      // Limited to the category's roles, or held for the approver when the model could not be asked.
      const allowed = (seg.sensitivity as string[]).flatMap((c) => map[c] ?? []);
      expect(subset(roles, [...allowed, LAB.approverRole]), `${p.contains} -> ${roles.join(",")}`).toBe(true);
      expect(roles).not.toContain(LAB.successorRole);
      for (const role of LAB.restrictedAudienceRoles) expect(roles).not.toContain(role);
    }
  });

  it("recovery switches on for the lab and builds a ladder from the lab's own people and roles", async () => {
    const res = await setLeaverUnreachable(lab, true, LAB.approverRole, "Wiring test");
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.gaps).toBeGreaterThan(0);
    const ladder = await listLadder(lab, LAB.approverRole);
    expect(ladder.length).toBe(res.gaps);
    // Every rung of every gap has an outcome (a person, a trace, an option, or "found nothing").
    for (const g of ladder) for (const rung of [1, 2, 3] as const) expect(g.rungs[rung].length, `${g.responsibilityKey}.${g.checkKey} rung ${rung}`).toBeGreaterThan(0);
    const targets = (await sql`SELECT DISTINCT target_role FROM recovery_steps WHERE workspace_id = ${lab} AND target_role IS NOT NULL`).map((r) => String(r.target_role));
    expect(subset(targets, LAB.roleOrder)).toBe(true);
    expect(targets).not.toContain(LAB.leaverRole);
    // No sample answers are shipped for the lab: the questions simply come without one.
    for (const role of LAB.roleOrder) for (const q of await questionsForRole(lab, role)) expect(q.sample).toBeNull();
    // Nothing from recovery reaches a role the placeholders are limited away from.
    for (const role of LAB.roleOrder) {
      const text = (await recoveryColumns(lab, role)).map((s) => s.text).join("\n");
      const [health] = LAB_GT.sensitivityPlaceholders.filter((p) => p.proposedCategory === "health");
      if (!(LAB.sensitivity as Record<string, RoleKey[]>).health.includes(role)) expect(text, role).not.toContain(health.contains);
    }
    expect((await setLeaverUnreachable(lab, false, LAB.approverRole)).ok).toBe(true);
  });

  it("First weeks on the lab: empty before a snapshot, then the open gaps with the lab's example finding", async () => {
    const before = await firstWeeks(lab, LAB.successorRole);
    expect(before.hasSnapshot).toBe(false);
    expect(before.blocking).toEqual([]);

    await sql`UPDATE claims SET review = 'approved' WHERE workspace_id = ${lab} AND state IN ('active', 'conflicting')`;
    for (const g of await listBlockingGaps(lab)) {
      const r = await savePlanItem(lab, { responsibilityId: g.responsibilityId, checkKey: g.checkKey, owner: "Incoming postdoc", dueDate: "2026-12-15", riskNote: "Known gap; checked weekly." }, LAB.approverRole);
      expect(r.ok).toBe(true);
    }
    const snap = await approveSnapshot(lab, LAB.approverRole);
    expect(snap.ok, snap.ok ? "" : snap.error).toBe(true);

    const fw = await firstWeeks(lab, LAB.successorRole);
    expect(fw.hasSnapshot).toBe(true);
    expect(fw.blocking.length).toBeGreaterThan(0);
    const example = exampleFinding(LAB);
    expect(example, "data/lab/ground_truth.json firstWeeks.example").not.toBeNull();
    const row = [...fw.blocking, ...fw.other].find((g) => g.example);
    expect(row, "the gap the lab's example finding closes").toBeTruthy();
    expect(row!.example).toEqual({ answer: example!.answer, note: example!.note });
    expect(row!.canRecord).toBe(true);
    const res = await recordFinding(lab, LAB.successorRole, {
      responsibilityId: row!.responsibilityId, checkKey: row!.checkKey, answer: row!.example!.answer, note: row!.example!.note, example: true,
    });
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    expect((await listFindings(lab, LAB.approverRole)).some((f) => f.status === "pending")).toBe(true);
    // The roles of the lab that do not record findings see the checklist, read-only.
    const other = await firstWeeks(lab, LAB.approverRole);
    expect([...other.blocking, ...other.other].every((g) => !g.canRecord)).toBe(true);
    expect((await listResponsibilities(lab)).length).toBeGreaterThan(0);
  });
});
