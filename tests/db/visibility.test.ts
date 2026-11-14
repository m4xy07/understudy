// Widening and limiting one segment. Spec 02 section 14, tests T13 to T17.
// Needs a migrated database: pnpm db:up && pnpm db:migrate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { getSegment, listClaims } from "@/lib/db/queries";
import { createEmptyWorkspace, ingestSources } from "@/lib/pipeline/ingest";
import { compileHandover } from "@/lib/relay";
import { loadEvidence } from "@/lib/relay";
import { packSensitivity } from "@/lib/tether/sensitivity";
import { countLimited, listSensitive, sensitiveSummary, setSegmentVisibility } from "@/lib/tether/visibility";
import type { RoleKey } from "@/lib/types";
import { CLUB, CLUB_APPROVER_LABEL, CLUB_ID } from "../helpers/club";

const sql = db();
let ws = "";
const ALL: RoleKey[] = [...CLUB.roleOrder];
const APPROVER = CLUB.approverRole;
const PACK = packSensitivity(CLUB);
const FINANCE = ALL.filter((r) => PACK.roles.finance.includes(r));
const HEALTH = ALL.filter((r) => PACK.roles.health.includes(r));
const NARROW_SOURCE: RoleKey[] = ["president", "tech_lead", "treasurer"];
const REASON = "Routine deposit, it backs the lab booking steps.";

const CHAT = [
  "01/11/26, 10:00 - Ananya Iyer: Priya paid Rs 450 for the lab booking deposit, I will reimburse her on Monday.",
  "01/11/26, 10:05 - Rohan Mehta: Build day is Saturday at 5 pm in Lab 3.",
  "01/11/26, 11:00 - Dev Malhotra: I am having knee surgery on 17 Nov, out for two weeks.",
  "01/11/26, 12:00 - Kabir Sethi: Sneha told me the encoder wheel slips on the left side.",
].join("\n");
const SIDE = "02/11/26, 09:00 - Rohan Mehta: My father is in hospital, I am out on Monday.";

const id: Record<string, string> = {};
const head = async (seg: string) => (await sql`SELECT * FROM segments WHERE workspace_id = ${ws} AND id = ${seg} ORDER BY version DESC LIMIT 1`)[0];
const versions = async (seg: string) => (await sql`SELECT version FROM segments WHERE workspace_id = ${ws} AND id = ${seg} ORDER BY version`).map((r) => Number(r.version));
const canRead = async (role: RoleKey, seg: string) => (await getSegment(ws, seg, role)) !== null;

beforeAll(async () => {
  ws = await createEmptyWorkspace("visibility fixture", CLUB_ID);
  await ingestSources(ws, [
    { kind: "whatsapp", name: "Core chat", roleSet: ALL, files: [{ path: "Core chat.txt", content: CHAT }] },
    { kind: "whatsapp", name: "Leads chat", roleSet: NARROW_SOURCE, files: [{ path: "Leads chat.txt", content: SIDE }] },
  ], "upload", { sensitivityCall: null });
  const segs = await sql`SELECT id, text FROM segments WHERE workspace_id = ${ws}`;
  const of = (needle: string) => String(segs.find((s) => String(s.text).includes(needle))!.id);
  id.deposit = of("Rs 450");
  id.build = of("Build day");
  id.surgery = of("knee surgery");
  id.encoder = of("encoder wheel");
  id.father = of("hospital");
  const cite = (seg: string) => JSON.stringify([{ segmentId: seg, quote: null, accepted: true, exact: false }]);
  await sql`INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, citations, trust, role_set, valid_from, origin) VALUES
    (${ws}, 'clm_build', 'build-day', 'Build day', 'status', 'Saturday 5 pm', 'Build day is Saturday at 5 pm in Lab 3.', ${cite(id.build)}::jsonb, 'from_record', ${ALL}::text[], now(), 'extracted'),
    (${ws}, 'clm_encoder', 'drivetrain', 'Drivetrain', 'risk', 'encoder slips', 'The left encoder wheel slips.', ${cite(id.encoder)}::jsonb, 'from_record', ${ALL}::text[], now(), 'extracted')`;
  await sql`INSERT INTO snapshots (workspace_id, id, version, hash, approved_by, payload) VALUES (${ws}, 'snap_v1', 1, 'abc', ${APPROVER}, '{}'::jsonb)`;
  await sql`INSERT INTO snapshot_claims (workspace_id, snapshot_id, claim_id, entity, entity_label, attribute, statement, value, trust, role_set) VALUES
    (${ws}, 'snap_v1', 'clm_build', 'build-day', 'Build day', 'status', 'Build day is Saturday at 5 pm in Lab 3.', 'Saturday 5 pm', 'from_record', ${ALL}::text[]),
    (${ws}, 'snap_v1', 'clm_encoder', 'drivetrain', 'Drivetrain', 'risk', 'The left encoder wheel slips.', 'encoder slips', 'from_record', ${ALL}::text[])`;
  await sql`INSERT INTO gap_questions (workspace_id, id, rank, responsibility_id, check_key, gap_type, text, score) VALUES
    (${ws}, 'gq_open', 1, 'r1', 'owner', 'missing', 'Who owns the encoder fix?', 1)`;
  await sql`INSERT INTO test_runs (workspace_id, id, role, scores, results) VALUES
    (${ws}, 'trn_1', 'tech_lead', '{"b":0,"c":1,"k":1}'::jsonb,
     ${JSON.stringify([{ responsibilityId: "r1", checkKey: "owner", coverage: "covered", claimIds: ["clm_encoder"], bestTrust: "from_record", note: "The left encoder wheel slips." }])}::jsonb)`;
}, 60_000);

afterAll(async () => {
  if (ws) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("the Sensitive content panel data", () => {
  it("lists limited messages to the roles that can read them, with reason and both role sets", async () => {
    const rows = await listSensitive(ws, APPROVER);
    expect(rows.map((r) => r.segmentId).sort()).toEqual([id.deposit, id.surgery, id.father].sort());
    const deposit = rows.find((r) => r.segmentId === id.deposit)!;
    expect(deposit).toMatchObject({
      sourceName: "Core chat", authorName: "Ananya Iyer", categories: ["finance"], stage: "rule",
      reason: "mentions money a person owes or is owed", roleSet: FINANCE, roleSetOriginal: ALL,
    });
    const father = rows.find((r) => r.segmentId === id.father)!;
    expect(father.roleSet).toEqual(["president"]);
    expect(father.roleSetOriginal).toEqual(NARROW_SOURCE);
    // A finance role reads the deposit row only; a role outside every category reads none.
    expect((await listSensitive(ws, "treasurer")).map((r) => r.segmentId)).toEqual([id.deposit]);
    expect(await listSensitive(ws, "new_member")).toEqual([]);
  });

  it("T17: count_limited returns the right integer per role and nothing else", async () => {
    const expected: Record<RoleKey, number> = { president: 0, tech_lead: 3, new_member: 2, treasurer: 2, leaver: 1 };
    for (const role of ALL) expect(await countLimited(ws, role), role).toBe(expected[role]);
    const raw = await withRole(ws, "new_member", (tx) => tx`SELECT count_limited(${ws}::uuid, 'new_member') AS n`);
    expect(Object.keys(raw[0])).toEqual(["n"]);
    expect(typeof raw[0].n).toBe("number");
    // Asked about another workspace from inside a role-scoped read, it answers 0.
    const other = await createEmptyWorkspace("other", CLUB_ID);
    const cross = await withRole(other, "new_member", (tx) => tx`SELECT count_limited(${ws}::uuid, 'new_member') AS n`);
    expect(Number(cross[0].n)).toBe(0);
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${other}`;
    });
    const summary = await sensitiveSummary(ws, APPROVER);
    expect(summary).toMatchObject({ limited: 3, held: 0, widened: 0, hidden: 0 });
    expect(Object.values(summary.perSource).sort()).toEqual([1, 2]);
    expect((await sensitiveSummary(ws, "new_member")).perSource).toEqual({});
  });
});

describe("T13: who may widen, and how far", () => {
  it.each(["leaver", "tech_lead", "treasurer", "new_member"] as RoleKey[])("%s is refused", async (role) => {
    const res = await setSegmentVisibility(ws, id.deposit, { action: "widen", roles: "source", reason: REASON }, role);
    expect(res).toEqual({ ok: false, error: `Only the approver (${CLUB_APPROVER_LABEL}) can change who sees this.` });
  });

  it("the approver needs a written reason of at least 10 characters", async () => {
    for (const reason of ["", "ok", "fine ", "   short   "]) {
      const res = await setSegmentVisibility(ws, id.deposit, { action: "widen", roles: "source", reason }, APPROVER);
      expect(res).toEqual({ ok: false, error: "Write why, in at least 10 characters." });
    }
  });

  it("a widen never goes beyond the roles of the source, and never drops a role that already sees it", async () => {
    const beyond = await setSegmentVisibility(ws, id.father, { action: "widen", roles: ["president", "tech_lead", "new_member"], reason: REASON }, APPROVER);
    expect(beyond).toEqual({ ok: false, error: "You can only widen back to the roles of the source." });
    const dropping = await setSegmentVisibility(ws, id.deposit, { action: "widen", roles: ["president", "tech_lead"], reason: REASON }, APPROVER);
    expect(dropping).toEqual({ ok: false, error: "You can only widen back to the roles of the source." });
    const unknown = await setSegmentVisibility(ws, "seg_missing", { action: "widen", roles: "source", reason: REASON }, APPROVER);
    expect(unknown.ok).toBe(false);
    const notLimited = await setSegmentVisibility(ws, id.build, { action: "widen", roles: "source", reason: REASON }, APPROVER);
    expect(notLimited).toEqual({ ok: false, error: "This message is not limited." });
  });

  it("nothing was written by the refused attempts", async () => {
    expect(await versions(id.deposit)).toEqual([1]);
    expect(await versions(id.father)).toEqual([1]);
    const audits = await sql`SELECT 1 FROM audit_log WHERE workspace_id = ${ws} AND action IN ('widen_segment', 'limit_segment')`;
    expect(audits.length).toBe(0);
  });
});

describe("T14 and T15: widening, then limiting again", () => {
  it("T14: a valid widen writes version 2, an audit row with the reason, and starts a run", async () => {
    expect(await canRead("new_member", id.deposit)).toBe(false);
    const res = await setSegmentVisibility(ws, id.deposit, { action: "widen", roles: "source", reason: `  ${REASON}  ` }, APPROVER);
    expect(res).toMatchObject({ ok: true, version: 2, changed: true });
    if (!res.ok) return;
    expect(res.runId).toBeTruthy();
    const [run] = await sql`SELECT status FROM runs WHERE workspace_id = ${ws} AND id = ${res.runId}`;
    expect(run.status).toBe("running");
    expect(await versions(id.deposit)).toEqual([1, 2]);
    const v2 = await head(id.deposit);
    expect(v2).toMatchObject({ sensitivity: ["finance"], sensitivity_stage: "widened", visibility_note: REASON, visibility_actor: APPROVER });
    expect(v2.role_set).toEqual(ALL);
    expect(v2.role_set_original).toEqual(ALL);
    const [a] = await sql`SELECT actor, detail FROM audit_log WHERE workspace_id = ${ws} AND action = 'widen_segment'`;
    const detail = typeof a.detail === "string" ? JSON.parse(a.detail) : a.detail;
    expect(a.actor).toBe(APPROVER);
    expect(detail).toMatchObject({ segmentId: id.deposit, fromVersion: 1, toVersion: 2, from: FINANCE, to: ALL, categories: ["finance"], reason: REASON });
    expect(await canRead("new_member", id.deposit)).toBe(true);
    // It still shows in the panel, now as widened.
    const row = (await listSensitive(ws, APPROVER)).find((r) => r.segmentId === id.deposit)!;
    expect(row).toMatchObject({ stage: "widened", note: REASON, version: 2 });
  });

  it("a double submit of the same widen changes nothing", async () => {
    const again = await setSegmentVisibility(ws, id.deposit, { action: "widen", roles: "source", reason: REASON }, APPROVER);
    expect(again).toMatchObject({ ok: true, version: 2, changed: false, runId: null });
    expect(await versions(id.deposit)).toEqual([1, 2]);
    const audits = await sql`SELECT 1 FROM audit_log WHERE workspace_id = ${ws} AND action = 'widen_segment'`;
    expect(audits.length).toBe(1);
  });

  it("a partial widen adds only the chosen roles", async () => {
    const res = await setSegmentVisibility(ws, id.father, { action: "widen", roles: ["president", "treasurer"], reason: REASON }, APPROVER);
    expect(res).toMatchObject({ ok: true, version: 2 });
    expect((await head(id.father)).role_set).toEqual(["president", "treasurer"]);
    expect(await canRead("tech_lead", id.father)).toBe(false);
  });

  it("T15: after limiting again, a role that could read version 2 cannot read the segment at all", async () => {
    const res = await setSegmentVisibility(ws, id.deposit, { action: "limit", categories: ["finance"], reason: "On second thought this names a person's money." }, APPROVER);
    expect(res).toMatchObject({ ok: true, version: 3, changed: true });
    expect(await versions(id.deposit)).toEqual([1, 2, 3]);
    expect((await head(id.deposit)).role_set).toEqual(FINANCE);
    expect(await canRead("new_member", id.deposit)).toBe(false);
    // The older, wider version 2 is still stored, and no reader can reach it by any query.
    for (const role of ["new_member", "tech_lead"] as RoleKey[]) {
      const any = await withRole(ws, role, (tx) => tx`SELECT version FROM segments WHERE workspace_id = ${ws} AND id = ${id.deposit}`);
      expect(any).toEqual([]);
      const pinned = await withRole(ws, role, (tx) => tx`SELECT version FROM segments WHERE workspace_id = ${ws} AND id = ${id.deposit} AND version = 2`);
      expect(pinned).toEqual([]);
      expect(await loadEvidence(ws, role, [id.deposit])).toEqual({});
    }
    // A role that may read it reads the head version only.
    const fin = await withRole(ws, "treasurer", (tx) => tx`SELECT version FROM segments WHERE workspace_id = ${ws} AND id = ${id.deposit}`);
    expect(fin.map((r) => Number(r.version))).toEqual([3]);
    const [a] = await sql`SELECT detail FROM audit_log WHERE workspace_id = ${ws} AND action = 'limit_segment'`;
    const detail = typeof a.detail === "string" ? JSON.parse(a.detail) : a.detail;
    expect(detail).toMatchObject({ segmentId: id.deposit, fromVersion: 2, toVersion: 3, to: FINANCE });
  });
});

describe("T16: a manual limit takes effect at once", () => {
  it("claims and snapshot claims that cite the segment are narrowed, and the excluded role's handover shows a stub", async () => {
    const before = await compileHandover(ws, "new_member");
    expect(before.withheld).toBe(0);
    expect(JSON.stringify(before.groups)).toContain("encoder");
    expect((await listClaims(ws, { role: "new_member" })).map((c) => c.id).sort()).toEqual(["clm_build", "clm_encoder"]);

    const refused = await setSegmentVisibility(ws, id.encoder, { action: "limit", categories: [], reason: REASON }, APPROVER);
    expect(refused).toEqual({ ok: false, error: "Pick what kind of content this is." });
    const notApprover = await setSegmentVisibility(ws, id.encoder, { action: "limit", categories: ["hr"], reason: REASON }, "leaver");
    expect(notApprover.ok).toBe(false);

    const res = await setSegmentVisibility(ws, id.encoder, { action: "limit", categories: ["hr"], reason: "Second-hand remark about a member's work." }, APPROVER);
    expect(res).toMatchObject({ ok: true, version: 2, changed: true });

    // No pipeline run has executed: the run row is only started.
    const v2 = await head(id.encoder);
    expect(v2).toMatchObject({ sensitivity: ["hr"], sensitivity_stage: "manual", sensitivity_reason: "reads like a complaint about a person" });
    expect(v2.role_set).toEqual(ALL.filter((r) => PACK.roles.hr.includes(r)));
    expect(v2.role_set_original).toEqual(ALL);
    const [claim] = await sql`SELECT role_set FROM claims WHERE workspace_id = ${ws} AND id = 'clm_encoder'`;
    expect(claim.role_set).toEqual(v2.role_set);
    const [frozen] = await sql`SELECT role_set FROM snapshot_claims WHERE workspace_id = ${ws} AND claim_id = 'clm_encoder'`;
    expect(frozen.role_set).toEqual(v2.role_set);
    const [other] = await sql`SELECT role_set FROM claims WHERE workspace_id = ${ws} AND id = 'clm_build'`;
    expect(other.role_set).toEqual(ALL);

    expect((await listClaims(ws, { role: "new_member" })).map((c) => c.id)).toEqual(["clm_build"]);
    const after = await compileHandover(ws, "new_member");
    expect(after.withheld).toBe(1);
    expect(after.stubLine).toBe(`1 restricted item. Ask the approver (${CLUB_APPROVER_LABEL}).`);
    expect(JSON.stringify(after.groups)).not.toContain("encoder");
    expect(JSON.stringify(after.doc)).not.toContain("encoder");
    // The approver still reads it.
    expect(JSON.stringify((await compileHandover(ws, APPROVER)).groups)).toContain("encoder");

    // Open gap questions are rebuilt by the next run; stand-in notes that may quote the claim are blanked.
    expect((await sql`SELECT 1 FROM gap_questions WHERE workspace_id = ${ws}`).length).toBe(0);
    const [run] = await sql`SELECT results FROM test_runs WHERE workspace_id = ${ws} AND id = 'trn_1'`;
    const results = typeof run.results === "string" ? JSON.parse(run.results) : run.results;
    expect(results[0].note).toBe("");
  });

  it("limiting the same segment the same way again changes nothing", async () => {
    const again = await setSegmentVisibility(ws, id.encoder, { action: "limit", categories: ["hr"], reason: "Second-hand remark about a member's work." }, APPROVER);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(await versions(id.encoder)).toEqual([1, 2]);
  });

  it("a limit never adds a role: health on a finance-limited message keeps only roles in both lists", async () => {
    const res = await setSegmentVisibility(ws, id.deposit, { action: "limit", categories: ["health"], reason: "It also mentions a medical matter." }, APPROVER);
    expect(res.ok).toBe(true);
    expect((await head(id.deposit)).role_set).toEqual(FINANCE.filter((r) => HEALTH.includes(r)));
  });
});
