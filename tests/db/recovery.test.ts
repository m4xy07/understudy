// Unreachable-leaver recovery against the local database on the club demo.
// T-DB-1 to T-DB-10 of docs/round3/specs/01_recovery.md ("done when" D1 to D9).
// The demo sources are ingested by Tether; claims are the planted ones from ground_truth.json (as a
// perfect extractor would produce them); the stand-in runs deterministically (no model).
// Needs a migrated database (pnpm db:up && pnpm db:migrate).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { getLatestTestRun, getWorkspace, listClaims, listResponsibilities } from "@/lib/db/queries";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { verify } from "@/lib/attest";
import { verifyDrafts } from "@/lib/attest/core/verify";
import { attestPack } from "@/lib/attest";
import {
  answerAsNeighbour, answerQuestion, askedRoles, buildInventory, buildLadder, buildQuestions, declineAsNeighbour, listLadder,
  listQuestions, listTraces, questionsForRole, recoveryComparison, recoveryState, recoverySurfaces, runTest, setLeaverUnreachable,
} from "@/lib/lacuna";
import { traceToDraft } from "@/lib/lacuna/core/ladder";
import { scanForCanaries } from "@/lib/relay/core/canary";
import type { Responsibility, RoleKey, TestRun } from "@/lib/types";
import { seedGroundTruthClaims } from "../lacuna/gt-seed";
import { CLUB, CLUB_ID } from "../helpers/club";

process.env.LACUNA_MODEL = "off";
const sql = db();
const ROLES = CLUB.roleOrder as RoleKey[];
const APPROVER = CLUB.approverRole as RoleKey;
const SUCCESSOR = CLUB.successorRole as RoleKey;
const LEAVER = CLUB.leaverRole as RoleKey;

let ws = "";
let resps: Responsibility[] = [];
let before: TestRun;
const log: string[] = [];

const stepRows = (where = sql``) => sql`SELECT * FROM recovery_steps WHERE workspace_id = ${ws} ${where} ORDER BY responsibility_id, check_key, rung, position, id`;
const audits = async (action: string) => (await sql`SELECT * FROM audit_log WHERE workspace_id = ${ws} AND action = ${action}`).length;
const respOf = (entity: string) => resps.find((r) => r.entities.includes(entity))!;

beforeAll(async () => {
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  await seedGroundTruthClaims(ws);
  await buildInventory(ws);
  resps = await listResponsibilities(ws);
  before = await runTest(ws, SUCCESSOR, { model: "off", trigger: "test" });
  for (const role of CLUB.testRoles) if (role !== SUCCESSOR) await runTest(ws, role, { model: "off", trigger: "test" });
  await buildQuestions(ws);
}, 180_000);

afterAll(async () => {
  console.log(`\n[recovery] workspace ${ws}\n${log.join("\n")}\n`);
  if (ws && !process.env.LACUNA_KEEP_WS) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("T-DB-1 (D1): the switch", () => {
  it("is off by default and nobody sees recovery surfaces", async () => {
    expect(await recoveryState(ws)).toMatchObject({ on: false, at: null, baselineRunId: null });
    expect(await recoverySurfaces(ws, APPROVER)).toEqual([]);
    expect(await questionsForRole(ws, SUCCESSOR)).toEqual([]);
  });

  it("refuses every role but the approver, for on and for off", async () => {
    for (const role of ROLES.filter((r) => r !== APPROVER)) {
      const on = await setLeaverUnreachable(ws, true, role);
      expect(on).toEqual({ ok: false, error: "Only Club President can change this." });
      expect((await setLeaverUnreachable(ws, false, role)).ok).toBe(false);
    }
    expect((await recoveryState(ws)).on).toBe(false);
    expect(await audits("recovery_on")).toBe(0);
  });

  it("the approver switches it on: one audit row, the baseline run is stored, pressing twice changes nothing", async () => {
    const res = await setLeaverUnreachable(ws, true, APPROVER, "Graduated early, phone is off.");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message).toMatch(/^Recovery is on\. \d+ gaps are being worked without Priya\. This is in the audit log\.$/);
    const state = await recoveryState(ws);
    expect(state.on).toBe(true);
    expect(state.note).toBe("Graduated early, phone is off.");
    expect(state.baselineRunId).toBe(before.id);
    expect(await audits("recovery_on")).toBe(1);
    const again = await setLeaverUnreachable(ws, true, APPROVER, "second press");
    expect(again.ok).toBe(true);
    expect(await audits("recovery_on")).toBe(1);
    expect((await recoveryState(ws)).note).toBe("Graduated early, phone is off.");
    expect((await recoveryState(ws)).baselineRunId).toBe(before.id);
  });
});

describe("T-DB-2 (D2): the ladder", () => {
  it("every open gap question has an outcome stored for rungs 1, 2 and 3", async () => {
    const open = (await listQuestions(ws)).filter((q) => !q.answeredClaimId);
    expect(open.length).toBeGreaterThan(5);
    const rows = await stepRows();
    for (const q of open) {
      for (const rung of [1, 2, 3]) {
        const n = rows.filter((r) => r.responsibility_id === q.responsibilityId && r.check_key === q.checkKey && Number(r.rung) === rung).length;
        expect(n, `${q.text} rung ${rung}`).toBeGreaterThan(0);
      }
    }
    const statuses = new Set(rows.map((r) => String(r.status)));
    for (const s of ["asked", "skipped_no_access", "skipped_no_seat", "found", "offered", "none", "not_applicable"]) expect(statuses.has(s), s).toBe(true);
    log.push(`ladder: ${rows.length} rows, statuses ${[...statuses].join(", ")}`);
  });

  it("a rebuild is idempotent: same ids, same statuses", async () => {
    const a = (await stepRows()).map((r) => `${r.id}:${r.status}`);
    await buildLadder(ws);
    const b = (await stepRows()).map((r) => `${r.id}:${r.status}`);
    expect(b).toEqual(a);
    expect(await audits("recovery_ladder_built")).toBeGreaterThanOrEqual(2);
  });

  it("a neighbour is asked a question built for their own role, with a reason made of counts", async () => {
    const [asked] = await stepRows(sql`AND status = 'asked' AND target_role = ${SUCCESSOR}`);
    expect(asked.question_text).toBeTruthy();
    expect(String(asked.reason)).toMatch(/^(Wrote|Replied|Was in|Changed|Shared) \d+ /);
    expect((asked.role_set as string[])).toContain(SUCCESSOR);
    expect(await askedRoles(ws)).toEqual(expect.arrayContaining([SUCCESSOR, APPROVER]));
  });
});

describe("T-DB-3 (D3): a skipped neighbour learns nothing", () => {
  it("the skipped role cannot read the row, gets no question, and sees no trace of being considered", async () => {
    const skipped = await stepRows(sql`AND status = 'skipped_no_access'`);
    expect(skipped.length).toBeGreaterThan(0);
    const names = Object.fromEntries((await sql`SELECT id, display_name FROM people WHERE workspace_id = ${ws}`).map((p) => [String(p.id), String(p.display_name)]));
    for (const s of skipped) {
      const role = String(s.target_role);
      const person = names[String(s.target_person)];
      log.push(`skipped: ${person} (${role}) on ${resps.find((r) => r.id === s.responsibility_id)?.key}.${s.check_key}`);
      expect(s.role_set as string[]).not.toContain(role);
      // direct read as us_reader with that role's claim
      const direct = await withRole(ws, role, (tx) => tx`SELECT id FROM recovery_steps WHERE workspace_id = ${ws} AND id = ${String(s.id)}`);
      expect(direct).toHaveLength(0);
      const rung1 = await withRole(ws, role, (tx) => tx`
        SELECT id FROM recovery_steps WHERE workspace_id = ${ws} AND responsibility_id = ${String(s.responsibility_id)}
          AND check_key = ${String(s.check_key)} AND rung = 1 AND target_person = ${String(s.target_person)}`);
      expect(rung1).toHaveLength(0);
      const mine = await questionsForRole(ws, role);
      const resp = resps.find((r) => r.id === s.responsibility_id)!;
      expect(mine.some((q) => q.responsibilityKey === resp.key && q.personId === String(s.target_person))).toBe(false);
      const gap = (await listLadder(ws, role)).find((g) => g.responsibilityId === s.responsibility_id && g.checkKey === s.check_key)!;
      expect(gap.rungs[1].some((x) => x.targetPerson === String(s.target_person))).toBe(false);
      const surfaces = (await recoverySurfaces(ws, role)).map((x) => x.text).join("\n");
      const aboutGap = surfaces.split("\n").filter((line) => line.startsWith(`${resp.key} | ${gap.checkLabel}`) && line.includes(person));
      expect(aboutGap).toEqual([]);
      expect(surfaces).not.toContain(String(s.reason));
      // the approver, who may see the topic, does see the skip
      const forApprover = (await listLadder(ws, APPROVER)).find((g) => g.responsibilityId === s.responsibility_id && g.checkKey === s.check_key)!;
      expect(forApprover.rungs[1].some((x) => x.status === "skipped_no_access" && x.targetPerson === String(s.target_person))).toBe(true);
    }
  });

  it("the planted skip is there: the Treasurer is not asked about the sponsor's open commitments", async () => {
    const sponsor = respOf("title-sponsor");
    const rows = await stepRows(sql`AND responsibility_id = ${sponsor.id} AND check_key = 'open_commitments' AND rung = 1`);
    const treasurer = rows.find((r) => r.target_role === "treasurer");
    expect(treasurer?.status).toBe("skipped_no_access");
    expect((await questionsForRole(ws, "treasurer")).some((q) => q.responsibilityKey === sponsor.key)).toBe(false);
  });

  it("no row is readable by a role outside its role set, for every role", async () => {
    const all = await stepRows();
    for (const role of ROLES) {
      const visible = new Set((await withRole(ws, role, (tx) => tx`SELECT id FROM recovery_steps WHERE workspace_id = ${ws}`)).map((r) => String(r.id)));
      for (const r of all) expect(visible.has(String(r.id)), `${role} ${r.id}`).toBe((r.role_set as string[]).includes(role));
    }
    await expect(withRole(ws, APPROVER, (tx) => tx`UPDATE recovery_steps SET status = 'answered' WHERE workspace_id = ${ws}`)).rejects.toThrow(/permission denied/i);
  });
});

describe("T-DB-8 (D4): traces are Inferred claims with checked citations", () => {
  it("stores each trace with trust inferred and origin trace; every citation is accepted", async () => {
    const traces = (await listClaims(ws)).filter((c) => c.origin === "trace");
    expect(traces.length).toBeGreaterThanOrEqual(4);
    for (const c of traces) {
      expect(c.trust).toBe("inferred");
      expect(c.state).toBe("active");
      expect(c.citations.length).toBeGreaterThan(0);
      expect(c.citations.every((x) => x.accepted)).toBe(true);
      expect(c.stateNote).toMatch(/^Rebuilt from the record: \d+ of \d+ steps quoted$/);
    }
    log.push(`traces: ${traces.map((c) => `${c.entity}/${c.attribute}`).join(", ")}`);
  });

  it("lists them for a role that may see them, with the CI run history among them and steps marked quoted or derived", async () => {
    const views = await listTraces(ws, SUCCESSOR);
    const runs = views.find((v) => v.traceKind === "run_history")!;
    expect(runs.title).toBe("Rebuilt from the run history of .github/workflows/deploy.yml");
    expect(runs.steps.some((s) => s.kind === "quoted" && s.exact && /failed at "pio test -e native"/.test(s.text))).toBe(true);
    expect(runs.steps.some((s) => s.kind === "derived")).toBe(true);
    expect(views.some((v) => v.traceKind === "workflow" && v.steps.some((s) => s.text === "Needs these secrets by name: OTA_PASSWORD"))).toBe(true);
    const web = views.find((v) => v.entity === "website-registration")!;
    expect(web.helps.map((h) => h.checkLabel)).toEqual(["Next concrete step"]);
  });

  it("a trace that cites a segment of another workspace is dropped by the verifier", async () => {
    const draft = traceToDraft({
      id: "trc_x", kind: "workflow", entityKey: "firmware-deploy", attribute: "procedure", title: "t", sourceLabel: "x.yml", value: "v", roleSet: ROLES,
      steps: [{ n: 1, text: "run it", kind: "quoted", citations: [{ segmentId: "seg_from_elsewhere", quote: "run it" }] }],
    });
    const vr = verifyDrafts([draft], new Map(), attestPack(CLUB), ws);
    expect(vr.claims).toEqual([]);
    expect(vr.dropped).toHaveLength(1);
  });

  it("an Inferred trace lifts its gap to Partial and no further: B is unchanged", async () => {
    const after = (await getLatestTestRun(ws, SUCCESSOR))!;
    expect(after.scores.b).toBe(before.scores.b);
    const web = respOf("website-registration");
    const was = before.results.find((r) => r.responsibilityId === web.id && r.checkKey === "next_concrete_step")!;
    const now = after.results.find((r) => r.responsibilityId === web.id && r.checkKey === "next_concrete_step")!;
    expect(was.coverage).toBe("missing");
    expect(now.coverage).toBe("partial");
    expect(now.bestTrust).toBe("inferred");
    expect(after.scores.k!).toBeLessThanOrEqual(before.scores.k!);
  });
});

describe("T-DB-4 and T-DB-5 (D4, D5, D6): a neighbour answers", () => {
  let stepId = "";
  let claimId = "";
  const deploy = () => respOf("firmware-deploy");

  it("the wrong role is refused, and so is the leaver's own answer box", async () => {
    const [step] = await stepRows(sql`AND responsibility_id = ${deploy().id} AND check_key = 'credential_owner' AND status = 'asked'`);
    stepId = String(step.id);
    expect(step.target_role).toBe(SUCCESSOR);
    for (const role of ROLES.filter((r) => r !== SUCCESSOR)) {
      expect(await answerAsNeighbour(ws, stepId, "I know it.", role)).toEqual({ ok: false, error: "Only the person who was asked can answer this." });
    }
    const q = (await listQuestions(ws)).find((x) => !x.answeredClaimId)!;
    expect(await answerQuestion(ws, q.id, "Here is the answer.", LEAVER)).toEqual({
      ok: false, error: "Priya is marked as unreachable. Club President can switch this off.",
    });
    expect((await answerAsNeighbour(ws, stepId, " ", SUCCESSOR)).ok).toBe(false);
  });

  it("the asked role answers: an answer segment, a Second-hand claim, an event, and the step is answered", async () => {
    const bBefore = (await getLatestTestRun(ws, SUCCESSOR))!.scores;
    const res = await answerAsNeighbour(ws, stepId, "Priya has it. She typed it on the lab laptop herself each time. I asked on 4 Nov and never got it.", SUCCESSOR);
    expect(res.ok).toBe(true);
    if (!res.ok || res.declined) throw new Error("expected an answer");
    claimId = res.claimId;
    expect(res.delta).toMatch(/^B \d+ \(no change\) · C \d+% → \d+% · K \d+% → \d+%$/);
    const [claim] = (await listClaims(ws)).filter((c) => c.id === claimId);
    expect(claim).toMatchObject({ trust: "second_hand", origin: "neighbour_answer", state: "active", entity: "firmware-deploy", importance: "blocking", tier: "C" });
    expect(claim.statement).toMatch(/^Arjun Rao said \(second-hand\): Priya has it\./);
    expect(claim.roleSet).toEqual(ROLES); // every record on this topic the neighbour can see is open to all roles
    const [seg] = await sql`SELECT * FROM segments WHERE workspace_id = ${ws} AND id = ${claim.citations[0].segmentId}`;
    expect(seg).toMatchObject({ source_id: "src_recovery", kind: "answer", source_kind: "interview" });
    expect(String(seg.thread)).toMatch(/^recovery:R\d+:credential_owner:p-\d+$/);
    const [src] = await sql`SELECT name, segment_count FROM sources WHERE workspace_id = ${ws} AND id = 'src_recovery'`;
    expect(src).toMatchObject({ name: "Recovery answers", segment_count: 1 });
    const events = await sql`SELECT event, data, actor FROM claim_events WHERE workspace_id = ${ws} AND claim_id = ${claimId}`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "created", actor: SUCCESSOR });
    const [step] = await stepRows(sql`AND id = ${stepId}`);
    expect(step).toMatchObject({ status: "answered", claim_id: claimId });
    expect(await audits("neighbour_answer")).toBe(1);
    // D5: a blocking check answered only Second-hand stays Partial; B does not fall, K does not rise
    const after = (await getLatestTestRun(ws, SUCCESSOR))!;
    const r = after.results.find((x) => x.responsibilityId === deploy().id && x.checkKey === "credential_owner")!;
    expect(r.coverage).toBe("partial");
    expect(r.bestTrust).toBe("second_hand");
    expect(after.scores.b).toBe(bBefore.b);
    expect(after.scores.c).toBeGreaterThan(bBefore.c);
    expect(after.scores.k!).toBeLessThanOrEqual(bBefore.k!);
  });

  it("a double submit stores nothing more", async () => {
    expect(await answerAsNeighbour(ws, stepId, "Priya has it. She typed it on the lab laptop herself each time. I asked on 4 Nov and never got it.", SUCCESSOR))
      .toEqual({ ok: false, error: "You already answered this." });
    expect(await declineAsNeighbour(ws, stepId, SUCCESSOR)).toEqual({ ok: false, error: "You already answered this." });
    expect((await listClaims(ws)).filter((c) => c.origin === "neighbour_answer")).toHaveLength(1);
    await buildLadder(ws, { model: false });
    const [step] = await stepRows(sql`AND id = ${stepId}`);
    expect(step.status).toBe("answered"); // a rebuild never overwrites an answered row
  });

  it("T-DB-5: the gap question stays open for the leaver, options are not claims, and the answer shows as a lead", async () => {
    const q = (await listQuestions(ws)).find((x) => x.responsibilityId === deploy().id && x.checkKey === "credential_owner")!;
    expect(q.answeredClaimId).toBeNull();
    const rung3 = await stepRows(sql`AND rung = 3`);
    expect(rung3.length).toBeGreaterThan(0);
    expect((await listClaims(ws)).filter((c) => c.trust === "ranked_options")).toHaveLength(0);
    const lead = rung3.find((r) => r.responsibility_id === deploy().id && r.check_key === "credential_owner" && r.kind === "option")!;
    const leadDetail = (typeof lead.detail === "string" ? JSON.parse(lead.detail) : lead.detail) as { single: boolean; sources: string[] };
    expect(leadDetail.single).toBe(true);
    expect(leadDetail.sources).toEqual(["weak"]);
    expect(lead.claim_id).toBeNull();
    const gap = (await listLadder(ws, APPROVER)).find((g) => g.responsibilityId === deploy().id && g.checkKey === "credential_owner")!;
    expect(gap.state).toBe("partly");
    expect(gap.rungs[1].find((s) => s.status === "answered")?.statement).toMatch(/said \(second-hand\)/);
  });

  it("a Second-hand answer on a check of weight 3 closes it, with a role set narrowed by the neighbour", async () => {
    const lateAccess = respOf("lab-late-access");
    const [step] = await stepRows(sql`AND responsibility_id = ${lateAccess.id} AND check_key = 'how_to_do_it' AND status = 'asked'`);
    const role = String(step.target_role);
    const res = await answerAsNeighbour(ws, String(step.id), "Ask the lab office by Monday, then sign the late register at the gate.", role, { narrowRoles: [SUCCESSOR] });
    expect(res.ok).toBe(true);
    if (!res.ok || res.declined) throw new Error("expected an answer");
    const [claim] = (await listClaims(ws)).filter((c) => c.id === res.claimId);
    expect(new Set(claim.roleSet)).toEqual(new Set([role, APPROVER, SUCCESSOR])); // narrowed; own role and approver stay
    const after = (await getLatestTestRun(ws, SUCCESSOR))!;
    const r = after.results.find((x) => x.responsibilityId === lateAccess.id && x.checkKey === "how_to_do_it")!;
    expect(r.coverage).toBe("covered");
    expect(r.bestTrust).toBe("second_hand");
    const gap = (await listLadder(ws, APPROVER)).find((g) => g.responsibilityId === lateAccess.id && g.checkKey === "how_to_do_it")!;
    expect(gap.state).toBe("closed");
    expect(gap.rungs[3].map((s) => s.status)).toEqual(["not_applicable"]);
  });

  it("I don't know is a decline: nothing is stored as evidence and no score moves", async () => {
    const scores = (await getLatestTestRun(ws, SUCCESSOR))!.scores;
    const claims = (await listClaims(ws)).length;
    const [step] = await stepRows(sql`AND status = 'asked' AND target_role = ${SUCCESSOR}`);
    expect(await declineAsNeighbour(ws, String(step.id), APPROVER === SUCCESSOR ? LEAVER : "treasurer")).toMatchObject({ ok: false });
    expect(await declineAsNeighbour(ws, String(step.id), SUCCESSOR)).toEqual({ ok: true, declined: true });
    const [typed] = await stepRows(sql`AND status = 'asked' AND target_role = ${APPROVER}`);
    expect(await answerAsNeighbour(ws, String(typed.id), "Not sure, ask Priya", APPROVER)).toEqual({ ok: true, declined: true });
    expect((await listClaims(ws)).length).toBe(claims);
    expect((await getLatestTestRun(ws, SUCCESSOR))!.scores).toEqual(scores);
    expect((await stepRows(sql`AND status = 'declined'`)).length).toBe(2);
    expect(await audits("neighbour_declined")).toBe(2);
  });
});

describe("D7: the before and after panel", () => {
  it("fewer gaps close without the leaver than with the leaver, and each column says what it rests on", async () => {
    const c = (await recoveryComparison(ws))!;
    expect(c.withLeaver.source).toBe("projection");
    expect(c.withLeaver.summary.closed).toBe(c.withLeaver.summary.worked);
    expect(c.without.summary.worked).toBe(c.withLeaver.summary.worked);
    expect(c.without.summary.closed).toBeGreaterThan(0);
    expect(c.without.summary.closed).toBeLessThan(c.withLeaver.summary.closed);
    expect(c.without.summary.closed + c.without.summary.partly + c.without.summary.open).toBe(c.without.summary.worked);
    expect(c.withLeaver.scores.b).toBeLessThan(c.without.scores.b);
    expect(c.without.scores.b).toBe(before.scores.b);
    expect(c.without.mix.second_hand).toBeGreaterThan(0);
    expect(c.without.mix.inferred).toBeGreaterThan(0);
    expect(c.withLeaver.mix.leaver_said).toBeGreaterThan(0);
    expect((c.without.mix.from_record ?? 0) + (c.without.mix.corroborated ?? 0)).toBeCloseTo(c.without.scores.k!);
    log.push(`with the leaver: closed ${c.withLeaver.summary.closed}/${c.withLeaver.summary.worked}, B ${c.withLeaver.scores.b}; without: closed ${c.without.summary.closed}, partly ${c.without.summary.partly}, open ${c.without.summary.open}, B ${c.without.scores.b}`);
  });
});

describe("T-DB-9: nothing restricted leaks through recovery", () => {
  it("no canary token outside a role's visibility appears on any recovery surface", async () => {
    const tokenRe = /CANARY-[A-Z0-9]+/gi;
    const allText = (await sql`SELECT text FROM segments WHERE workspace_id = ${ws}`).map((r) => String(r.text)).join("\n");
    const allTokens = [...new Set(allText.match(tokenRe) ?? [])];
    expect(allTokens.length).toBeGreaterThan(3);
    for (const role of ROLES) {
      const visible = (await withRole(ws, role, (tx) => tx`SELECT text FROM segments WHERE workspace_id = ${ws}`)).map((r) => String(r.text)).join("\n");
      const allowed = new Set(visible.match(tokenRe) ?? []);
      const surfaces = await recoverySurfaces(ws, role);
      expect(surfaces.map((s) => s.surface)).toEqual(["recovery neighbours", "recovery questions for this role", "recovery traces", "recovery options"]);
      expect(scanForCanaries(surfaces, allowed, allTokens), role).toEqual([]);
    }
    expect((await recoverySurfaces(ws, APPROVER)).map((s) => s.text).join("\n").length).toBeGreaterThan(500);
  });
});

describe("T-DB-10: re-testing one responsibility", () => {
  it("changes results only for that responsibility and matches a full deterministic run", async () => {
    const prev = (await getLatestTestRun(ws, SUCCESSOR))!;
    const one = respOf("firmware-deploy");
    const partial = await runTest(ws, SUCCESSOR, { model: "off", only: [one.id], trigger: "test only" });
    const full = await runTest(ws, SUCCESSOR, { model: "off", trigger: "test full" });
    expect(partial.scores).toEqual(full.scores);
    expect(partial.results).toEqual(full.results);
    expect(partial.results.filter((r) => r.responsibilityId !== one.id)).toEqual(prev.results.filter((r) => r.responsibilityId !== one.id));
  });
});

describe("T-DB-6 (D9): switching off", () => {
  it("restores the normal Ask flow and keeps the labelled evidence", async () => {
    const res = await setLeaverUnreachable(ws, false, APPROVER);
    expect(res).toMatchObject({ ok: true, message: "Recovery is off. Priya can answer again. Second-hand answers and rebuilt procedures stay, with their labels." });
    expect(await audits("recovery_off")).toBe(1);
    await setLeaverUnreachable(ws, false, APPROVER);
    expect(await audits("recovery_off")).toBe(1);
    expect((await getWorkspace(ws))?.leaverUnreachable).toBe(false);
    const claims = await listClaims(ws);
    expect(claims.filter((c) => c.trust === "second_hand" && c.state === "active").length).toBe(2);
    expect(claims.filter((c) => c.origin === "trace" && c.trust === "inferred" && c.state === "active").length).toBeGreaterThanOrEqual(4);
    expect((await stepRows()).length).toBeGreaterThan(10); // rows remain
    expect(await questionsForRole(ws, SUCCESSOR)).toEqual([]);
    expect(await recoverySurfaces(ws, SUCCESSOR)).toEqual([]);
    const [asked] = await stepRows(sql`AND status = 'asked'`);
    expect(await answerAsNeighbour(ws, String(asked.id), "Late answer.", String(asked.target_role))).toEqual({ ok: false, error: "Recovery is off. Priya answers these now." });
    const q = (await listQuestions(ws)).find((x) => !x.answeredClaimId && x.checkKey === "credential_owner")!;
    const ans = await answerQuestion(ws, q.id, "Arjun Rao holds it now; I handed it over in person on 9 Nov.", LEAVER);
    expect(ans.ok).toBe(true);
    const after = (await getLatestTestRun(ws, SUCCESSOR))!;
    const r = after.results.find((x) => x.responsibilityId === q.responsibilityId && x.checkKey === "credential_owner")!;
    expect(r.coverage).toBe("covered");
    expect(r.bestTrust).toBe("leaver_said");
  });

  it("switching on again resumes the unanswered steps and keeps the answered ones", async () => {
    const res = await setLeaverUnreachable(ws, true, APPROVER);
    expect(res.ok).toBe(true);
    expect(await audits("recovery_on")).toBe(2);
    expect((await stepRows(sql`AND status = 'answered'`)).length).toBe(2);
    expect((await stepRows(sql`AND status = 'declined'`)).length).toBe(2);
    expect((await questionsForRole(ws, APPROVER)).length).toBeGreaterThan(0);
  });
});

describe("T-DB-7: a pipeline re-run keeps recovery claims and lets them touch nothing", () => {
  it("verify() carries neighbour answers and traces over untouched, outside the rules", async () => {
    const mine = (await listClaims(ws)).filter((c) => c.origin === "neighbour_answer" || c.origin === "trace");
    await verify(ws, { support: false });
    const after = await listClaims(ws);
    for (const c of mine) {
      const now = after.find((x) => x.id === c.id)!;
      expect(now, c.id).toBeDefined();
      expect({ state: now.state, trust: now.trust, origin: now.origin, statement: now.statement }).toEqual({ state: c.state, trust: c.trust, origin: c.origin, statement: c.statement });
    }
    const ids = mine.map((c) => c.id);
    const hurt = await sql`SELECT id FROM claims WHERE workspace_id = ${ws} AND superseded_by = ANY(${ids}::text[])`;
    expect(hurt).toHaveLength(0);
    const firings = await sql`SELECT verification FROM attest_runs WHERE workspace_id = ${ws}`;
    expect(JSON.stringify(firings[0]?.verification ?? {})).not.toMatch(new RegExp(ids.join("|")));
  });
});
