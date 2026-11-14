// Living handover against the local database: record, withdraw, review, re-test, next snapshot,
// the stored diff and the role-scoped "What changed" panel. The demo sources are ingested by
// Tether; claims are the planted ones of the answer key; the stand-in runs deterministically.
// Needs a migrated database (pnpm db:up && pnpm db:migrate).
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { getLatestTestRun, listClaims, listResponsibilities } from "@/lib/db/queries";
import { buildInventory, claimMeta, listBlockingGaps, runTest, savePlanItem } from "@/lib/lacuna";
import { getExtraction, reconstruct, rerunRules, verify } from "@/lib/attest";
import { approveSnapshot, compileHandover, listSnapshotHistory, parsePayload } from "@/lib/relay";
import { diffSnapshots, verifySnapshot } from "@/lib/relay/core/snapshot";
import { REASONS } from "@/lib/relay/core/changes";
import { FINDING_ERRORS } from "@/lib/relay/core/finding";
import {
  changeTexts, decideFinding, firstWeeks, firstWeeksTexts, listFindings, listOpenGaps, recordFinding, retestOptions, whatChanged,
  withdrawFinding, type OpenGapRow,
} from "@/lib/relay/living";
import type { RoleKey, TestRun } from "@/lib/types";
import { seedGroundTruthClaims } from "../lacuna/gt-seed";
import { CLUB_DEMO_DIR, CLUB_ID } from "../helpers/club";

process.env.LACUNA_MODEL = "off";
const sql = db();
let ws = "";
const ALL: RoleKey[] = ["president", "tech_lead", "new_member", "treasurer", "leaver"];
const GT = JSON.parse(fs.readFileSync(path.join(process.cwd(), CLUB_DEMO_DIR, "ground_truth.json"), "utf8")) as {
  finding: { entity: string; checkKey: string; date: string; note: string; expectedBlockingDelta: number };
};
const OPENED = { evidenceOpened: true, note: "Checked with the lab office, this is right." };
const CANARY = "CANARY-FW77";
const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

let lateGap: OpenGapRow;
let v1Run: TestRun;
let exampleFindingId = "";
let exampleClaimId = "";

const snapshotCount = async () => Number((await sql`SELECT count(*)::int AS n FROM snapshots WHERE workspace_id = ${ws}`)[0].n);
const successorRun = async () => (await getLatestTestRun(ws, "tech_lead"))!;
/** jsonb written as a JSON string parameter comes back as a string. */
const J = <T = any>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T; // eslint-disable-line @typescript-eslint/no-explicit-any
const fresh = (n: number) => `Checked on site, attempt ${n}.`;

/** An open gap the successor can still record on, other than the ones already used. */
async function freeGap(used: Set<string>, opts: { blocking?: boolean; text?: boolean } = {}): Promise<OpenGapRow> {
  const rows = (await listOpenGaps(ws, "tech_lead")).filter((g) =>
    g.canRecord && !used.has(`${g.responsibilityId}|${g.checkKey}`)
    && (opts.blocking === undefined || g.blocking === opts.blocking) && (!opts.text || !g.needsDate));
  expect(rows.length, "an open gap to record on").toBeGreaterThan(0);
  used.add(`${rows[0].responsibilityId}|${rows[0].checkKey}`);
  return rows[0];
}
const used = new Set<string>();

beforeAll(async () => {
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  await seedGroundTruthClaims(ws);
  await buildInventory(ws);
  // The planted states stand in for a verify() run: bring them in line with the rules once, so a
  // later re-run of the rules changes only what a finding changes.
  await rerunRules(ws, "system");
  expect((await rerunRules(ws, "system")).changed).toBe(0);
  await runTest(ws, "tech_lead", { model: "off", trigger: "test" });
  await runTest(ws, "new_member", { model: "off", trigger: "test" });
}, 180_000);

afterAll(async () => {
  if (ws && !process.env.LIVING_KEEP_WS) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("retestOptions: which responsibilities a finding re-tests", () => {
  const resps = [
    { id: "r1", entities: ["lab-late-access"] },
    { id: "r2", entities: ["budget"] },
    { id: "r3", entities: ["keys", "lab-late-access"] },
  ];
  it("its own responsibility and any that share an entity; the trigger names the finding", () => {
    expect(retestOptions("fnd_1", "r1", resps)).toEqual({ trigger: "finding fnd_1", only: ["r1", "r3"] });
    expect(retestOptions("fnd_2", "r2", resps)).toEqual({ trigger: "finding fnd_2", only: ["r2"] });
  });
  it("an unknown responsibility re-tests everything", () => {
    expect(retestOptions("fnd_3", "gone", resps)).toEqual({ trigger: "finding fnd_3" });
  });
});

describe("before the first snapshot", () => {
  it("First weeks is empty and a finding is refused", async () => {
    const fw = await firstWeeks(ws, "tech_lead");
    expect(fw.hasSnapshot).toBe(false);
    expect(fw.blocking).toEqual([]);
    const gap = (await listBlockingGaps(ws))[0];
    const res = await recordFinding(ws, "tech_lead", { responsibilityId: gap.responsibilityId, checkKey: gap.checkKey, answer: "x", note: "" });
    expect(res).toEqual({ ok: false, error: FINDING_ERRORS.noSnapshot });
    expect(await changeTexts(ws, "tech_lead")).toEqual([]);
  });

  it("snapshot v1 is approved with every blocking gap planned, and stores a first-release record", async () => {
    await sql`UPDATE claims SET review = 'approved' WHERE workspace_id = ${ws} AND state IN ('active', 'conflicting')`;
    for (const g of await listBlockingGaps(ws)) {
      const r = await savePlanItem(ws, {
        responsibilityId: g.responsibilityId, checkKey: g.checkKey,
        owner: "Incoming tech lead", dueDate: "2026-11-30", riskNote: "Known gap; checked weekly.",
      }, "president");
      expect(r.ok).toBe(true);
    }
    const snap = await approveSnapshot(ws, "president");
    expect(snap.ok).toBe(true);
    expect(snap.snapshot!.version).toBe(1);
    v1Run = await successorRun();
    const [ch] = await sql`SELECT * FROM snapshot_changes WHERE workspace_id = ${ws} AND snapshot_id = 'snap_v1'`;
    expect(ch.from_snapshot_id).toBeNull();
    expect(ch.test_run_id).toBe(v1Run.id);
    expect(J(ch.cause)).toMatchObject({ type: "first" });
    const view = (await whatChanged(ws, "tech_lead", "snap_v1"))!;
    expect(view.why).toBe("First release");
    expect(view.scores[0]).toBe(`B is ${v1Run.scores.b}.`);
  });
});

describe("First weeks checklist", () => {
  it("shows every open blocking gap with owner and due date from the plan, to every role", async () => {
    const blocking = await listBlockingGaps(ws);
    for (const role of ALL) {
      const fw = await firstWeeks(ws, role);
      expect(fw.hasSnapshot).toBe(true);
      expect(fw.blocking.map((g) => `${g.responsibilityId}|${g.checkKey}`).sort())
        .toEqual(blocking.map((g) => `${g.responsibilityId}|${g.checkKey}`).sort());
      for (const g of fw.blocking) expect(g.plan).toMatchObject({ owner: "Incoming tech lead", dueDate: "2026-11-30" });
      // Only the successor gets a record button; the other open gaps go to the successor and the approver only.
      expect(fw.blocking.some((g) => g.canRecord)).toBe(role === "tech_lead");
      if (role !== "tech_lead" && role !== "president") expect(fw.other).toEqual([]);
    }
    const mine = await firstWeeks(ws, "tech_lead");
    expect(mine.other.length).toBeGreaterThan(0);
    expect(mine.counts.open).toBe(mine.blocking.length + mine.other.length);
    // A gap the successor may not see evidence for cannot take a finding.
    for (const g of mine.blocking.filter((x) => x.restricted)) expect(g.canRecord).toBe(false);
  });

  it("the demo's example finding sits on the late-access date gap and nowhere else", async () => {
    const rows = await listOpenGaps(ws, "tech_lead");
    const withExample = rows.filter((g) => g.example);
    expect(withExample).toHaveLength(1);
    lateGap = withExample[0];
    expect(lateGap.checkKey).toBe(GT.finding.checkKey);
    expect(lateGap.blocking).toBe(true);
    expect(lateGap.needsDate).toBe(true);
    expect(lateGap.example).toEqual({ answer: GT.finding.date, note: GT.finding.note });
    used.add(`${lateGap.responsibilityId}|${lateGap.checkKey}`);
  });
});

describe("recording a finding", () => {
  it("only the successor records", async () => {
    for (const role of ["president", "leaver", "treasurer", "new_member"] as RoleKey[]) {
      const res = await recordFinding(ws, role, {
        responsibilityId: lateGap.responsibilityId, checkKey: lateGap.checkKey, answer: GT.finding.date, note: GT.finding.note,
      });
      expect(res).toEqual({ ok: false, error: "Only Incoming tech lead can record findings." });
    }
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM findings WHERE workspace_id = ${ws}`;
    expect(n).toBe(0);
  });

  it("form rules hold on the server: a date check needs a date that has not passed", async () => {
    const at = { responsibilityId: lateGap.responsibilityId, checkKey: lateGap.checkKey, note: "" };
    expect(await recordFinding(ws, "tech_lead", { ...at, answer: "" })).toEqual({ ok: false, error: FINDING_ERRORS.noDate });
    expect(await recordFinding(ws, "tech_lead", { ...at, answer: "every Wednesday" })).toEqual({ ok: false, error: FINDING_ERRORS.noDate });
    expect(await recordFinding(ws, "tech_lead", { ...at, answer: "2026-11-04" })).toEqual({ ok: false, error: FINDING_ERRORS.pastDate });
    expect(await recordFinding(ws, "tech_lead", { ...at, answer: GT.finding.date, link: "see the notice board" }))
      .toEqual({ ok: false, error: FINDING_ERRORS.badLink });
    expect(await recordFinding(ws, "tech_lead", { ...at, answer: GT.finding.date, attachment: { name: "photo.png", bytes: new Uint8Array([1, 2]) } }))
      .toEqual({ ok: false, error: FINDING_ERRORS.fileType });
    expect(await recordFinding(ws, "tech_lead", { ...at, answer: GT.finding.date, attachment: { name: "a.txt", bytes: new Uint8Array([0x61, 0, 0x62]) } }))
      .toEqual({ ok: false, error: FINDING_ERRORS.fileType });
    expect(await recordFinding(ws, "tech_lead", { ...at, answer: GT.finding.date, attachment: { name: "a.txt", bytes: new Uint8Array(200 * 1024 + 1).fill(0x61) } }))
      .toEqual({ ok: false, error: FINDING_ERRORS.fileTooLarge });
  });

  it("the example finding is saved as evidence labelled Successor found, and nothing moves", async () => {
    const before = await successorRun();
    const metaBefore = await claimMeta(ws);
    const handoverBefore = JSON.stringify((await compileHandover(ws, "tech_lead")).doc);
    const res = await recordFinding(ws, "tech_lead", {
      responsibilityId: lateGap.responsibilityId, checkKey: lateGap.checkKey, answer: GT.finding.date, note: GT.finding.note,
      link: "https://college.example/workshop/late-access", example: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    exampleFindingId = res.findingId;
    exampleClaimId = res.claimId;
    expect(res.roleSet).toEqual(ALL);

    const claim = (await listClaims(ws)).find((c) => c.id === res.claimId)!;
    expect(claim).toMatchObject({
      trust: "successor_found", origin: "successor_finding", review: "pending", state: "active",
      entity: GT.finding.entity, attribute: "deadline", value: GT.finding.date, sourceKinds: ["finding"], tier: "C",
    });
    expect(claim.statement).toBe(`Incoming tech lead found: ${GT.finding.note}`);
    const [seg] = await sql`SELECT * FROM segments WHERE workspace_id = ${ws} AND id = ${claim.citations[0].segmentId}`;
    expect(seg.kind).toBe("finding");
    expect(seg.source_kind).toBe("finding");
    expect(seg.source_id).toBe("src_first_weeks");
    expect(String(seg.text)).toContain(claim.citations[0].quote!);
    expect(claim.citations[0]).toMatchObject({ quote: `Answer: ${GT.finding.date}`, accepted: true, exact: true });
    // The demo example uses a fixed time, so the claim id repeats in every demo workspace.
    expect(new Date(seg.ts).toISOString()).toBe("2026-11-12T06:30:00.000Z");

    // Nothing moves until the approver decides.
    const again = await runTest(ws, "tech_lead", { model: "off", trigger: "pending check" });
    expect(again.scores).toEqual(before.scores);
    expect(again.results.find((r) => r.responsibilityId === lateGap.responsibilityId && r.checkKey === lateGap.checkKey)!.coverage)
      .toBe(lateGap.coverage);
    const metaAfter = await claimMeta(ws);
    expect(metaAfter.has(res.claimId)).toBe(false);
    expect([...metaAfter.keys()].sort()).toEqual([...metaBefore.keys()].sort());
    expect(JSON.stringify((await compileHandover(ws, "tech_lead")).doc)).toBe(handoverBefore);
    expect(await snapshotCount()).toBe(1);
    await rerunRules(ws, "system");
    expect((await listClaims(ws)).find((c) => c.id === res.claimId)!.trust).toBe("successor_found");

    const row = (await listOpenGaps(ws, "tech_lead")).find((g) => g.responsibilityId === lateGap.responsibilityId && g.checkKey === lateGap.checkKey)!;
    expect(row.state).toBe("waiting");
    expect(row.canRecord).toBe(false);
    const [audit] = await sql`SELECT actor FROM audit_log WHERE workspace_id = ${ws} AND action = 'record_finding'`;
    expect(audit.actor).toBe("tech_lead");
  });

  it("saving twice is one finding; a different answer for the same gap is refused", async () => {
    const same = await recordFinding(ws, "tech_lead", {
      responsibilityId: lateGap.responsibilityId, checkKey: lateGap.checkKey, answer: GT.finding.date, note: GT.finding.note,
      link: "https://college.example/workshop/late-access", example: true,
    });
    expect(same).toMatchObject({ ok: true, findingId: exampleFindingId, claimId: exampleClaimId });
    const other = await recordFinding(ws, "tech_lead", {
      responsibilityId: lateGap.responsibilityId, checkKey: lateGap.checkKey, answer: "2026-11-25", note: "Changed my mind.",
    });
    expect(other).toEqual({ ok: false, error: FINDING_ERRORS.duplicate });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM findings WHERE workspace_id = ${ws}`;
    expect(n).toBe(1);
  });

  it("the link is kept as text, and the finding is listed for every role in its role set", async () => {
    for (const role of ALL) {
      const mine = await listFindings(ws, role);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        id: exampleFindingId, status: "pending", answer: GT.finding.date, note: GT.finding.note,
        link: "https://college.example/workshop/late-access", fileName: null, version: null, narrowedTo: null,
      });
      expect(mine[0].gap).toBe(`${lateGap.responsibilityTitle}: ${lateGap.checkLabel}`);
    }
  });
});

describe("the approver decides", () => {
  it("the leaver never approves; nobody but the approver does; tier C needs the evidence and a reason", async () => {
    expect(await decideFinding(ws, "leaver", exampleFindingId, "approved", OPENED))
      .toMatchObject({ ok: false, error: "The leaver can never approve." });
    for (const role of ["tech_lead", "treasurer", "new_member"] as RoleKey[]) {
      expect(await decideFinding(ws, role, exampleFindingId, "approved", OPENED))
        .toMatchObject({ ok: false, error: "Only Club President can approve findings." });
    }
    expect((await decideFinding(ws, "president", exampleFindingId, "approved", { evidenceOpened: false, note: OPENED.note })).ok).toBe(false);
    expect((await decideFinding(ws, "president", exampleFindingId, "approved", { evidenceOpened: true, note: "ok" })).ok).toBe(false);
    expect((await listFindings(ws, "president"))[0].status).toBe("pending");
    expect(await snapshotCount()).toBe(1);
  });

  it("approval re-tests, creates snapshot v2 and stores the diff: B one lower, C up, K not up", async () => {
    const res = await decideFinding(ws, "president", exampleFindingId, "approved", OPENED);
    expect(res.ok).toBe(true);
    expect(res.blocked).toBeUndefined();
    expect(res.snapshot!.version).toBe(2);
    const after = await successorRun();
    expect(after.scores.b - v1Run.scores.b).toBe(GT.finding.expectedBlockingDelta);
    expect(after.scores.c).toBeGreaterThan(v1Run.scores.c);
    expect(after.scores.k!).toBeLessThanOrEqual(v1Run.scores.k!);
    expect(res.delta).toBe(`B ${v1Run.scores.b} → ${after.scores.b}.`);
    const check = after.results.find((r) => r.responsibilityId === lateGap.responsibilityId && r.checkKey === lateGap.checkKey)!;
    expect(check).toMatchObject({ coverage: "covered", bestTrust: "successor_found" });
    expect(after.provisional).toBe(false);
    // Only the finding's responsibility (and any that share its entities) was judged again: the
    // result of every other one is the earlier run's, unchanged.
    const affected = new Set(retestOptions(exampleFindingId, lateGap.responsibilityId, await listResponsibilities(ws)).only);
    expect(affected.has(lateGap.responsibilityId)).toBe(true);
    const untouched = (r: { responsibilityId: string }) => !affected.has(r.responsibilityId);
    expect(after.results.filter(untouched).length).toBeGreaterThan(0);
    const core = (r: { responsibilityId: string; checkKey: string; coverage: string; claimIds: string[] }) =>
      [r.responsibilityId, r.checkKey, r.coverage, r.claimIds];
    expect(after.results.filter(untouched).map(core)).toEqual(v1Run.results.filter(untouched).map(core));

    const claim = (await listClaims(ws)).find((c) => c.id === exampleClaimId)!;
    expect(claim).toMatchObject({ review: "approved", trust: "successor_found", state: "active" });
    const [f] = await sql`SELECT * FROM findings WHERE workspace_id = ${ws} AND id = ${exampleFindingId}`;
    expect(f).toMatchObject({ status: "approved", snapshot_id: "snap_v2", review_note: OPENED.note });
    expect(String(f.score_delta)).toContain(`B ${v1Run.scores.b} → ${after.scores.b}`);
    expect(String(f.score_delta)).toContain("Successor found");

    // The stored diff is the diff of the two hashed payloads; v1 is untouched and still verifies.
    const rows = await sql`SELECT id, hash, payload FROM snapshots WHERE workspace_id = ${ws} ORDER BY version`;
    const [p1, p2] = rows.map((r) => parsePayload(r.payload)!);
    const [ch] = await sql`SELECT * FROM snapshot_changes WHERE workspace_id = ${ws} AND snapshot_id = 'snap_v2'`;
    const diff = J(ch.diff);
    expect(diff).toEqual(JSON.parse(JSON.stringify(diffSnapshots(p1, p2))));
    expect(diff).toMatchObject({ fromVersion: 1, toVersion: 2, added: [exampleClaimId], removed: [], changed: [], planChanged: true });
    expect(ch.from_snapshot_id).toBe("snap_v1");
    expect(ch.test_run_id).toBe(after.id);
    expect(J(ch.cause)).toEqual({ type: "finding", findingIds: [exampleFindingId] });
    expect(J(ch.gaps_closed)).toHaveLength(1);
    expect(J(ch.gaps_opened)).toEqual([]);
    expect(J(ch.gaps_closed)[0]).toMatchObject({ responsibilityId: lateGap.responsibilityId, checkKey: lateGap.checkKey, blocking: true, trust: "successor_found" });
    expect(J(ch.lines).b).toBe(`B went from ${v1Run.scores.b} to ${after.scores.b}. ${REASONS.bDownFinding(1)}`);
    expect(J(ch.lines).c).toContain(REASONS.cUp(1));
    expect(verifySnapshot(p1, String(rows[0].hash))).toBe(true);
    expect(verifySnapshot(p2, String(rows[1].hash))).toBe(true);
    expect(p2.schema).toBe("understudy.snapshot/1");
    // The record holds ids, numbers and fixed sentences: none of the finding's own words.
    expect(JSON.stringify(ch)).not.toContain("Pawar");

    const actions = (await sql`SELECT action FROM audit_log WHERE workspace_id = ${ws} ORDER BY id`).map((r) => String(r.action));
    for (const a of ["record_finding", "review_claim", "approve_snapshot", "decide_finding"]) expect(actions).toContain(a);
    expect((await listSnapshotHistory(ws)).map((h) => h.snapshot.version)).toEqual([2, 1]);
  });

  it("approving again changes nothing: same snapshot, no v3", async () => {
    const [a, b] = await Promise.all([
      decideFinding(ws, "president", exampleFindingId, "approved", OPENED),
      decideFinding(ws, "president", exampleFindingId, "approved", OPENED),
    ]);
    expect(a.snapshot!.version).toBe(2);
    expect(b.snapshot!.version).toBe(2);
    expect(await snapshotCount()).toBe(2);
    expect(await decideFinding(ws, "president", exampleFindingId, "rejected", OPENED)).toMatchObject({ ok: false });
  });

  it("the panel shows the claim added, the gap closed and the score change with its reason", async () => {
    const view = (await whatChanged(ws, "tech_lead", "snap_v2"))!;
    expect(view.heading).toBe("What changed in v2");
    expect(view.sub).toMatch(/^Compared with v1\. Approved .+ IST\.$/);
    expect(view.causeLine).toBe("Why: a successor finding was approved.");
    expect(view.why).toBe(`Finding approved: ${lateGap.responsibilityTitle}: ${lateGap.checkLabel}`);
    expect(view.claims).toEqual([{ kind: "added", claimId: exampleClaimId, text: `Added: Incoming tech lead found: ${GT.finding.note}` }]);
    expect(view.gaps).toEqual([`Gap closed: ${lateGap.responsibilityTitle}: ${lateGap.checkLabel}`]);
    expect(view.scores[0]).toMatch(/^B went from \d+ to \d+\. 1 blocking gap is now covered by a successor finding\.$/);
    expect(view.scores[1]).toMatch(/^C went from \d+% to \d+%\. 1 more check is covered\.$/);
    expect(view.scores[2]).toMatch(/^K (stayed at \d+%\.|went from \d+% to \d+%\. K counts only covered work that a record backs\. A finding is a person's word, so it raises C and not K\.)$/);
    expect(view.stub).toBeNull();
    expect(view.reack).toBe("This is a new version. Read back again to acknowledge v2.");
    // Every role in the finding's role set reads the same panel; each role's handover is v2.
    for (const role of ALL) {
      expect((await whatChanged(ws, role, "snap_v2"))!.claims).toHaveLength(1);
      const h = await compileHandover(ws, role);
      expect(h.snapshot!.version).toBe(2);
      expect(h.verified).toBe(true);
    }
    // The handover names the new date, labelled as the successor's finding.
    const doc = (await compileHandover(ws, "tech_lead")).doc!;
    const lines = doc.sections.flatMap((s) => s.lines).filter((l) => l.claimIds.includes(exampleClaimId));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.text).toContain(GT.finding.date);
      expect(l.trust).toBe("successor_found");
    }
    const fw = await firstWeeks(ws, "tech_lead");
    expect(fw.closed.map((g) => [g.checkKey, g.state, g.closedInVersion])).toEqual([[lateGap.checkKey, "closed", 2]]);
    expect(fw.counts.closed).toBe(1);
    expect(await recordFinding(ws, "tech_lead", { responsibilityId: lateGap.responsibilityId, checkKey: lateGap.checkKey, answer: "2026-11-25", note: "" }))
      .toEqual({ ok: false, error: FINDING_ERRORS.gapClosed });
  });
});

describe("masking and narrowing", () => {
  let narrowId = "";
  let gap: OpenGapRow;

  it("a token, an email and a phone number in the note and in the file are masked before storage", async () => {
    gap = await freeGap(used, { text: true });
    const file = `rota,contact\nwed,arjun.rao@example.com\nkey,token=${TOKEN}\n${CANARY} second copy\n`;
    const res = await recordFinding(ws, "tech_lead", {
      responsibilityId: gap.responsibilityId, checkKey: gap.checkKey,
      answer: "Ask the Zephyr desk",
      note: `Mail lab.office@example.com or call +91 98765 43210. The key is api_key=${TOKEN}. Ref ${CANARY}.`,
      attachment: { name: "rota.csv", bytes: new TextEncoder().encode(file) },
      // Ticked: only the successor. The approver is always kept; nobody else is added.
      narrowRoles: ["tech_lead", "ghost_role"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    narrowId = res.findingId;
    expect(res.roleSet).toEqual(["president", "tech_lead"]);

    const segs = await sql`SELECT text, role_set, position, meta FROM segments WHERE workspace_id = ${ws} AND source_id = 'src_first_weeks' AND thread LIKE ${`%:${gap.checkKey}`} ORDER BY position`;
    const mine = segs.filter((s) => String(s.text).includes(CANARY));
    expect(mine).toHaveLength(2);
    for (const s of mine) {
      expect(String(s.text)).not.toContain(TOKEN);
      expect(String(s.text)).not.toContain("example.com");
      expect(String(s.text)).not.toContain("98765");
      expect(String(s.text)).toContain("[SECRET:");
      expect(String(s.text)).toContain("[CONTACT:");
      expect(s.role_set).toEqual(["president", "tech_lead"]);
    }
    expect(J(mine[1].meta).attachment).toMatchObject({ name: "rota.csv" });
    const claim = (await listClaims(ws)).find((c) => c.id === res.claimId)!;
    expect(claim.roleSet).toEqual(["president", "tech_lead"]);
    expect(claim.tier).toBe("C"); // hidden from the restricted audience: evidence and a reason
    expect(JSON.stringify(claim)).not.toContain(TOKEN);
    const [f] = await sql`SELECT role_set FROM findings WHERE workspace_id = ${ws} AND id = ${narrowId}`;
    expect(f.role_set).toEqual(["president", "tech_lead"]);
    const contacts = await sql`SELECT role_set FROM contacts WHERE workspace_id = ${ws} AND source_id = 'src_first_weeks'`;
    expect(contacts.length).toBeGreaterThanOrEqual(2);
    for (const c of contacts) expect((c.role_set as string[]).every((r) => ["president", "tech_lead"].includes(r))).toBe(true);
    // The attached file is part of the finding, never a source of its own.
    const sources = await sql`SELECT id, kind FROM sources WHERE workspace_id = ${ws} AND kind = 'finding'`;
    expect(sources.map((s) => s.id)).toEqual(["src_first_weeks"]);
  });

  it("a role outside the role set reads no row and no text, before and after approval", async () => {
    const outside: RoleKey[] = ["new_member", "treasurer", "leaver"];
    const check = async () => {
      for (const role of outside) {
        const seen = await listFindings(ws, role);
        expect(seen.map((f) => f.id)).not.toContain(narrowId);
        const text = JSON.stringify([await changeTexts(ws, role), await firstWeeksTexts(ws, role), await firstWeeks(ws, role), seen]);
        expect(text).not.toContain(CANARY);
        expect(text).not.toContain("Zephyr");
        const rows = await withRole(ws, role, (tx) => tx`SELECT id FROM findings WHERE workspace_id = ${ws} AND id = ${narrowId}`);
        expect(rows).toHaveLength(0);
      }
      for (const role of ["president", "tech_lead"] as RoleKey[]) {
        expect(JSON.stringify(await firstWeeksTexts(ws, role))).toContain(CANARY);
      }
    };
    await check();
    const res = await decideFinding(ws, "president", narrowId, "approved", OPENED);
    expect(res.ok).toBe(true);
    expect(res.snapshot!.version).toBe(3);
    await check();

    // Inside the role set the panel names the claim; outside it is a count and nothing else.
    const inside = (await whatChanged(ws, "tech_lead", "snap_v3"))!;
    expect(inside.claims).toHaveLength(1);
    expect(inside.claims[0].text).toContain(CANARY);
    expect(inside.gaps).toEqual([`Gap closed: ${gap.responsibilityTitle}: ${gap.checkLabel}`]);
    expect(inside.stub).toBeNull();
    for (const role of outside) {
      const view = (await whatChanged(ws, role, "snap_v3"))!;
      expect(view.claims).toEqual([]);
      expect(view.gaps).toEqual([]);
      expect(view.hidden).toBe(2);
      expect(view.stub).toBe("2 restricted changes. Ask the approver (Club President).");
      expect(view.why).toBe("Finding approved");
      expect(view.counts).toEqual({ added: 1, removed: 0, changed: 0 });
      expect(JSON.stringify((await compileHandover(ws, role)).doc)).not.toContain(CANARY);
    }
    expect(JSON.stringify(await changeTexts(ws, "tech_lead"))).toContain(CANARY);
  });
});

describe("withdraw and reject", () => {
  it("the successor withdraws a waiting finding; the gap opens for a new one", async () => {
    const gap = await freeGap(used, { text: true });
    const res = await recordFinding(ws, "tech_lead", { responsibilityId: gap.responsibilityId, checkKey: gap.checkKey, answer: "In the blue folder", note: fresh(1) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((await withdrawFinding(ws, "president", res.findingId)).ok).toBe(false);
    expect((await withdrawFinding(ws, "tech_lead", res.findingId)).ok).toBe(true);
    expect((await withdrawFinding(ws, "tech_lead", res.findingId)).ok).toBe(true); // safe to repeat
    const mine = (await listFindings(ws, "tech_lead")).find((f) => f.id === res.findingId)!;
    expect(mine.status).toBe("withdrawn");
    expect((await listClaims(ws)).find((c) => c.id === res.claimId)!.state).toBe("dropped");
    expect((await decideFinding(ws, "president", res.findingId, "approved", OPENED)).ok).toBe(false);
    const row = (await listOpenGaps(ws, "tech_lead")).find((g) => g.responsibilityId === gap.responsibilityId && g.checkKey === gap.checkKey)!;
    expect(row).toMatchObject({ state: "open", canRecord: true });
    used.delete(`${gap.responsibilityId}|${gap.checkKey}`);
  });

  it("a rejected finding leaves no trace in the handover: gap open, no snapshot, reason shown", async () => {
    const gap = await freeGap(used, { text: true });
    const before = await successorRun();
    const count = await snapshotCount();
    const res = await recordFinding(ws, "tech_lead", { responsibilityId: gap.responsibilityId, checkKey: gap.checkKey, answer: "Probably the old cupboard", note: fresh(2) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = await decideFinding(ws, "president", res.findingId, "rejected", { evidenceOpened: true, note: "The cupboard was cleared in October." });
    expect(out).toEqual({ ok: true });
    expect((await decideFinding(ws, "president", res.findingId, "rejected", OPENED)).ok).toBe(true); // safe to repeat
    expect(await snapshotCount()).toBe(count);
    expect((await successorRun()).id).toBe(before.id); // no test run
    expect((await listClaims(ws)).find((c) => c.id === res.claimId)!.review).toBe("rejected");
    const mine = (await listFindings(ws, "tech_lead")).find((f) => f.id === res.findingId)!;
    expect(mine).toMatchObject({ status: "rejected", reviewNote: "The cupboard was cleared in October.", version: null });
    const row = (await listOpenGaps(ws, "tech_lead")).find((g) => g.responsibilityId === gap.responsibilityId && g.checkKey === gap.checkKey)!;
    expect(row).toMatchObject({ state: "rejected", canRecord: true, rejectedReason: "The cupboard was cleared in October." });
    expect(JSON.stringify((await compileHandover(ws, "tech_lead")).doc)).not.toContain("old cupboard");
    used.delete(`${gap.responsibilityId}|${gap.checkKey}`);
  });
});

describe("review finding 5: an approval that is saved is reported as saved", () => {
  it("when the re-test fails after the approval, the reply is ok with what is left; approving again finishes it", async () => {
    const gap = await freeGap(used, { blocking: false, text: true });
    const count = await snapshotCount();
    const res = await recordFinding(ws, "tech_lead", { responsibilityId: gap.responsibilityId, checkKey: gap.checkKey, answer: "On the shelf by the door", note: fresh(7) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await sql.unsafe("ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS tmp_living_f5");
    await sql.unsafe("ALTER TABLE test_runs ADD CONSTRAINT tmp_living_f5 CHECK (trigger NOT LIKE 'finding %') NOT VALID");
    let out;
    try {
      // Before the fix this threw: the page showed an error although the approval was stored.
      out = await decideFinding(ws, "president", res.findingId, "approved", OPENED);
    } finally {
      await sql.unsafe("ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS tmp_living_f5");
    }
    expect(out.ok).toBe(true);
    expect(out.unfinished).toMatch(/re-test could not run/);
    expect(out.snapshot).toBeUndefined();
    expect(await snapshotCount()).toBe(count);
    expect((await listFindings(ws, "president")).find((f) => f.id === res.findingId)!.status).toBe("approved");
    // The same click again does the rest.
    const again = await decideFinding(ws, "president", res.findingId, "approved", OPENED);
    expect(again.ok).toBe(true);
    expect(again.unfinished).toBeUndefined();
    expect(again.snapshot?.version).toBe(count + 1);
  });
});

describe("the release rule still gates every version", () => {
  it("when the plan has a hole the finding is approved, the snapshot waits and the blocker is named", async () => {
    const gap = await freeGap(used, { blocking: false, text: true });
    const count = await snapshotCount();
    const res = await recordFinding(ws, "tech_lead", { responsibilityId: gap.responsibilityId, checkKey: gap.checkKey, answer: "Every second Friday", note: fresh(3) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const stillOpen = (await listBlockingGaps(ws))[0];
    await sql`DELETE FROM plan_items WHERE workspace_id = ${ws} AND responsibility_id = ${stillOpen.responsibilityId} AND check_key = ${stillOpen.checkKey}`;

    const out = await decideFinding(ws, "president", res.findingId, "approved", OPENED);
    expect(out.ok).toBe(true);
    expect(out.snapshot).toBeUndefined();
    expect(out.blocked).toContain(`${stillOpen.responsibilityTitle}: ${stillOpen.checkLabel} needs`);
    expect(out.nextVersion).toBe(count + 1);
    expect(await snapshotCount()).toBe(count);
    const waiting = (await listFindings(ws, "president")).find((f) => f.id === res.findingId)!;
    expect(waiting).toMatchObject({ status: "approved", version: null });
    expect((await listClaims(ws)).find((c) => c.id === res.claimId)!.review).toBe("approved");

    // The approver fixes the plan and approves the snapshot by hand: that version carries the finding.
    await savePlanItem(ws, {
      responsibilityId: stillOpen.responsibilityId, checkKey: stillOpen.checkKey,
      owner: "Incoming tech lead", dueDate: "2026-12-05", riskNote: "Planned again.",
    }, "president");
    const snap = await approveSnapshot(ws, "president");
    expect(snap.ok).toBe(true);
    expect(snap.snapshot!.version).toBe(count + 1);
    const [ch] = await sql`SELECT cause, diff FROM snapshot_changes WHERE workspace_id = ${ws} AND snapshot_id = ${snap.snapshot!.id}`;
    expect(J(ch.cause)).toEqual({ type: "finding", findingIds: [res.findingId] });
    expect(J(ch.diff).added).toEqual([res.claimId]);
    expect(J(ch.diff).planChanged).toBe(true);
    const carried = (await listFindings(ws, "president")).find((f) => f.id === res.findingId)!;
    expect(carried.version).toBe(count + 1);
    const view = (await whatChanged(ws, "president", snap.snapshot!.id))!;
    expect(view.plan).toBe("The continuation plan changed.");
    // A version released by hand with nothing new says so.
    const manual = await approveSnapshot(ws, "president");
    const plain = (await whatChanged(ws, "president", manual.snapshot!.id))!;
    expect(plain).toMatchObject({ cause: "manual", why: "Released by the approver", causeLine: "Why: the approver released a new version.", empty: "No claims changed in this version." });
  });
});

describe("a record can back a finding later, and only a record", () => {
  it("a record with the same value makes the finding Corroborated; K rises and the next version lists it as changed", async () => {
    const before = await successorRun();
    const [seg] = await sql`SELECT id, source_id, ts FROM segments WHERE workspace_id = ${ws} AND source_kind = 'tasks_csv' ORDER BY id LIMIT 1`;
    // What a re-run of the pipeline would add after a new task card arrives through Connect.
    await sql`
      INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, state,
        role_set, valid_from, source_kinds, importance, tier, review, origin, source_ids)
      VALUES (${ws}, 'clm_test_record', ${GT.finding.entity}, 'Late-night lab access', 'deadline', ${GT.finding.date},
        'Late access is booked for 2026-11-18.', ${JSON.stringify([{ segmentId: seg.id, quote: null, accepted: true, exact: true }])}::jsonb,
        'from_record', 'active', ${ALL}::text[], ${seg.ts}, ${["tasks_csv"]}::text[], 'blocking', 'C', 'approved', 'structured',
        ${[String(seg.source_id)]}::text[])`;
    await rerunRules(ws, "system");
    const claims = await listClaims(ws);
    expect(claims.find((c) => c.id === exampleClaimId)!.trust).toBe("corroborated");
    expect(claims.find((c) => c.id === "clm_test_record")!.trust).toBe("corroborated");
    // Running the rules again keeps it: still corroborated only because the record still agrees.
    expect((await rerunRules(ws, "system")).changed).toBe(0);

    await runTest(ws, "tech_lead", { model: "off", trigger: "record arrived" });
    const after = await successorRun();
    expect(after.scores.k!).toBeGreaterThan(before.scores.k!);
    const snap = await approveSnapshot(ws, "president");
    expect(snap.ok).toBe(true);
    const view = (await whatChanged(ws, "tech_lead", snap.snapshot!.id))!;
    expect(view.claims.find((c) => c.claimId === exampleClaimId)).toMatchObject({
      kind: "trust",
      text: `Changed: Incoming tech lead found: ${GT.finding.note} Trust went from Successor found to Corroborated.`,
    });
    expect(view.scores[2]).toMatch(/^K went from \d+% to \d+%\. A record now agrees with a finding, so that work counts as backed by a record\.$/);

    // Take the record away again: the finding goes back to its own label.
    await sql`UPDATE claims SET state = 'dropped' WHERE workspace_id = ${ws} AND id = 'clm_test_record'`;
    await rerunRules(ws, "system");
    expect((await listClaims(ws)).find((c) => c.id === exampleClaimId)!.trust).toBe("successor_found");
  });
});

describe("a pipeline re-run cannot drop or launder a finding", () => {
  it("finding segments are never sent to extraction and finding claims survive verify()", async () => {
    const findingClaims = (await listClaims(ws)).filter((c) => c.origin === "successor_finding");
    expect(findingClaims.length).toBeGreaterThanOrEqual(4);
    await reconstruct(ws, { useModel: false });
    const drafts = (await getExtraction(ws))!.drafts;
    const findingSegs = new Set((await sql`SELECT id FROM segments WHERE workspace_id = ${ws} AND kind = 'finding'`).map((r) => String(r.id)));
    expect(findingSegs.size).toBeGreaterThanOrEqual(5);
    expect(drafts.some((d) => d.citations.some((c) => findingSegs.has(c.segmentId)))).toBe(false);
    await verify(ws, { support: false });
    const after = await listClaims(ws);
    for (const c of findingClaims) {
      const now = after.find((x) => x.id === c.id)!;
      expect(now).toMatchObject({ origin: "successor_finding", review: c.review, value: c.value, statement: c.statement, roleSet: c.roleSet });
      expect(now.state === "dropped").toBe(c.state === "dropped");
      expect(["successor_found", "corroborated"]).toContain(now.trust);
      expect(now.sourceKinds).toEqual(["finding"]);
    }
    expect(after.filter((c) => c.sourceKinds.includes("finding") && c.origin !== "successor_finding")).toEqual([]);
  });
});
