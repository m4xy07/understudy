// Security finding S1: when the approver limits a message, everything recovery derived from it
// shrinks in the same step. Option cards (quotes, values, reasons), rebuilt procedures, the
// question written for a neighbour and successor findings carry their own role sets; they used to
// stay readable by the roles the message was just taken from.
// The club demo with the planted claims; recovery on; the stand-in runs deterministically.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { rerunRules } from "@/lib/attest";
import {
  buildInventory, buildLadder, buildQuestions, listLadder, questionsForRole, recoverySurfaces, runTest, setLeaverUnreachable,
} from "@/lib/lacuna";
import { optionEvidenceReadable } from "@/lib/lacuna/recovery";
import { createDemoWorkspace } from "@/lib/pipeline/ingest";
import { executeRun } from "@/lib/pipeline/run";
import { runLeakCheck } from "@/lib/relay";
import { setSegmentVisibility } from "@/lib/tether/visibility";
import type { RoleKey } from "@/lib/types";
import { seedGroundTruthClaims } from "../lacuna/gt-seed";
import { CLUB, CLUB_ID } from "../helpers/club";

process.env.LACUNA_MODEL = "off";
const sql = db();
const ROLES = CLUB.roleOrder as RoleKey[];
const APPROVER = CLUB.approverRole as RoleKey;
const SUCCESSOR = CLUB.successorRole as RoleKey;

let ws = "";
interface Evidence { claimId: string; segmentId: string | null; quote: string | null; sourceKind?: string }
interface Row { id: string; role_set: RoleKey[]; detail: { value?: string; evidence?: Evidence[] }; responsibility_id: string; check_key: string }
let option: Row;
let evidence: Evidence;
let removed: RoleKey[] = [];
const parse = (rows: readonly Record<string, unknown>[]): Row[] => rows.map((r) => ({
  ...(r as unknown as Row), detail: (typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail) as Row["detail"],
}));
const rowsCiting = async (segmentId: string) => parse(await sql`
  SELECT id, role_set, detail, responsibility_id, check_key FROM recovery_steps
  WHERE workspace_id = ${ws} AND detail::text LIKE ${`%${segmentId}%`}`);

beforeAll(async () => {
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  await seedGroundTruthClaims(ws);
  await buildInventory(ws);
  await rerunRules(ws, "system");
  for (const role of CLUB.testRoles) await runTest(ws, role, { model: "off", trigger: "test" });
  await buildQuestions(ws);
  expect((await setLeaverUnreachable(ws, true, APPROVER, "On leave, no phone.")).ok).toBe(true);
}, 240_000);

afterAll(async () => {
  if (ws) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("S1: limiting a message reaches the recovery rows built from it", () => {
  it("before the limit, an option card quotes the message to roles other than the approver", async () => {
    const rows = parse(await sql`
      SELECT id, role_set, detail, responsibility_id, check_key FROM recovery_steps
      WHERE workspace_id = ${ws} AND rung = 3 AND kind = 'option' ORDER BY id`);
    const pick = rows
      .flatMap((r) => (r.detail.evidence ?? []).map((e) => ({ r, e })))
      .find(({ r, e }) => e.segmentId && e.quote && e.quote.length > 12 && e.sourceKind === "whatsapp" && r.role_set.some((x) => x !== APPROVER));
    expect(pick, "the demo ladder has an option card with a quoted message").toBeTruthy();
    option = pick!.r;
    evidence = pick!.e;
    const reader = option.role_set.find((x) => x !== APPROVER)!;
    const shown = (await recoverySurfaces(ws, reader)).map((s) => s.text).join("\n");
    expect(shown).toContain(evidence.quote!);
  });

  it("the limit narrows every recovery row and finding that rests on the message, in the same step", async () => {
    const [head] = await sql`SELECT role_set FROM segments WHERE workspace_id = ${ws} AND id = ${evidence.segmentId!} ORDER BY version DESC LIMIT 1`;
    // A finding that rests on a claim citing the message (as the successor would have recorded it).
    await sql`
      INSERT INTO findings (workspace_id, id, responsibility_id, check_key, segment_id, claim_id, recorded_by, role_set)
      VALUES (${ws}, 'fnd_s1_test', ${option.responsibility_id}, ${option.check_key}, 'seg_other', ${evidence.claimId}, ${SUCCESSOR}, ${ROLES}::text[])`;
    const res = await setSegmentVisibility(ws, evidence.segmentId!, { action: "limit", categories: ["hr"], reason: "This is about a member, approver only." }, APPROVER);
    expect(res.ok && res.changed).toBe(true);
    removed = (head.role_set as RoleKey[]).filter((r) => r !== APPROVER);
    expect(removed.length).toBeGreaterThan(0);

    // Stored rows: nothing that cites the message or its claims is left with a removed role.
    for (const r of await rowsCiting(evidence.segmentId!)) expect(r.role_set.filter((x) => removed.includes(x)), r.id).toEqual([]);
    const byClaim = await sql`SELECT id, role_set FROM recovery_steps WHERE workspace_id = ${ws} AND (claim_id = ${evidence.claimId} OR detail::text LIKE ${`%${evidence.claimId}%`})`;
    for (const r of byClaim) expect((r.role_set as RoleKey[]).filter((x) => removed.includes(x)), String(r.id)).toEqual([]);
    // Every option card of that gap (a proposal is written from all the gap's record claims).
    const cards = await sql`SELECT id, role_set FROM recovery_steps WHERE workspace_id = ${ws} AND kind = 'option' AND responsibility_id = ${option.responsibility_id}`;
    for (const r of cards) expect((r.role_set as RoleKey[]).filter((x) => removed.includes(x)), String(r.id)).toEqual([]);
    // No neighbour who lost the message is still asked a question written from it.
    const asked = await sql`SELECT target_role FROM recovery_steps WHERE workspace_id = ${ws} AND kind = 'neighbour' AND status = 'asked'
      AND question_text IS NOT NULL AND responsibility_id = ${option.responsibility_id}`;
    for (const a of asked) expect(removed).not.toContain(String(a.target_role));
    const [finding] = await sql`SELECT role_set FROM findings WHERE workspace_id = ${ws} AND id = 'fnd_s1_test'`;
    expect((finding.role_set as RoleKey[]).filter((x) => removed.includes(x))).toEqual([]);
  });

  it("a removed role reads no quote from the message on any recovery surface, under RLS", async () => {
    for (const role of removed) {
      const direct = await withRole(ws, role, (tx) => tx`SELECT id FROM recovery_steps WHERE workspace_id = ${ws} AND detail::text LIKE ${`%${evidence.segmentId!}%`}`);
      expect(direct, role).toHaveLength(0);
      const shown = (await recoverySurfaces(ws, role)).map((s) => s.text).join("\n");
      expect(shown, role).not.toContain(evidence.quote!);
      for (const q of await questionsForRole(ws, role)) expect(`${q.text}`, role).not.toContain(evidence.quote!);
    }
    // The approver still has it.
    expect((await rowsCiting(evidence.segmentId!)).every((r) => r.role_set.includes(APPROVER))).toBe(true);
  });

  it("the run the limit asks for rebuilds the ladder, and the rebuild does not bring the old role sets back", async () => {
    const [run] = await sql`SELECT id FROM runs WHERE workspace_id = ${ws} AND status IN ('running', 'paused')`;
    expect(run, "the limit started a run").toBeTruthy();
    expect((await executeRun(ws, String(run.id)))?.status).toBe("done");
    // The ask step rebuilt the ladder (recovery is on): once more by hand, as the approver's button would.
    await buildLadder(ws, { model: false });
    for (const r of await rowsCiting(evidence.segmentId!)) expect(r.role_set.filter((x) => removed.includes(x)), r.id).toEqual([]);
    for (const role of removed) {
      const shown = (await recoverySurfaces(ws, role)).map((s) => s.text).join("\n");
      expect(shown, role).not.toContain(evidence.quote!);
      const ladder = await listLadder(ws, role);
      for (const g of ladder) for (const s of g.rungs[3]) expect(JSON.stringify(s.detail), role).not.toContain(evidence.segmentId!);
    }
    const [built] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = ${ws} AND action = 'recovery_ladder_built'`;
    expect(Number(built.n)).toBeGreaterThanOrEqual(3); // switch-on, the run's ask step, the rebuild above
  }, 120_000);

  it("the read itself is defensive: an option card whose evidence the role cannot read is not shown", () => {
    const card = { kind: "option" as const, detail: { evidence: [{ claimId: "clm_a" }, { claimId: "clm_b" }] } };
    expect(optionEvidenceReadable(card, new Set(["clm_a", "clm_b"]))).toBe(true);
    expect(optionEvidenceReadable(card, new Set(["clm_a"]))).toBe(false);
    expect(optionEvidenceReadable({ kind: "neighbour", detail: {} }, new Set())).toBe(true);
  });

  it("the leak grid stays green", async () => {
    const r = await runLeakCheck(ws, { judge: "off" });
    expect(r.cells.filter((c) => c.leaks > 0).map((c) => `${c.role}/${c.surface}/${c.row}`)).toEqual([]);
    expect(r.allPass).toBe(true);
  }, 120_000);
});
