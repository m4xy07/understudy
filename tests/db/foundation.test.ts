// Round 3 foundation, against the real database (pnpm db:up && pnpm db:migrate):
//   - a workspace stores its pack id and its pack's approver and leaver roles, and they never change;
//   - the database still refuses a snapshot approved by the leaver or by anyone but the approver,
//     without a role key in the schema;
//   - role_holders is filled from the pack's roleHolders when a workspace is created;
//   - the widened enum checks accept the new source kind, segment kind, trust and origins;
//   - verify() keeps every claim Attest did not derive from the record, and extraction never
//     sends an answer or a finding to the model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { claimRow, segmentRow, toClaim } from "@/lib/db/mappers";
import { getWorkspace } from "@/lib/db/queries";
import { reconstruct, verify } from "@/lib/attest";
import type { ModelCall } from "@/lib/attest/core/schema";
import { getWorkspacePack } from "@/lib/pack";
import { createDemoWorkspace, createEmptyWorkspace } from "@/lib/pipeline/ingest";
import { ensureRoleHolders, listRoleHolders } from "@/lib/roles";
import { sha256Hex } from "@/lib/text/norm";
import type { Claim, ClaimOrigin, Segment, Trust } from "@/lib/types";
import { CLUB, CLUB_ID } from "../helpers/club";

const sql = db();
let ws = "";
let empty = "";

async function purge(id: string) {
  if (!id) return;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('us.allow_purge', 'on', true)`;
    await tx`DELETE FROM workspaces WHERE id = ${id}`;
  });
}

beforeAll(async () => {
  ws = (await createDemoWorkspace(CLUB_ID)).id;
  empty = await createEmptyWorkspace("foundation fixture");
}, 120_000);

afterAll(async () => {
  await purge(ws);
  await purge(empty);
  await sql.end();
});

const snapshotRow = (workspace: string, id: string, version: number, approvedBy: string) => ({
  workspace_id: workspace, id, version, hash: "f".repeat(64), approved_by: approvedBy, payload: JSON.stringify({ v: version }),
});

describe("a workspace knows its pack", () => {
  it("stores the pack id and the pack's approver and leaver roles at creation", async () => {
    for (const id of [ws, empty]) {
      const [row] = await sql`SELECT pack_id, approver_role, leaver_role FROM workspaces WHERE id = ${id}`;
      expect(row).toMatchObject({ pack_id: CLUB.id, approver_role: CLUB.approverRole, leaver_role: CLUB.leaverRole });
      expect((await getWorkspace(id))?.packId).toBe(CLUB.id);
      expect((await getWorkspacePack(id)).id).toBe(CLUB.id);
    }
  });

  it("an empty workspace gets the default pack of packs/index.json", async () => {
    expect((await getWorkspacePack(empty)).id).toBe("club");
  });

  it("pack id, approver role and leaver role can never be changed; other columns can", async () => {
    await expect(sql`UPDATE workspaces SET pack_id = 'other' WHERE id = ${empty}`).rejects.toThrow(/never changes its setting pack/);
    await expect(sql`UPDATE workspaces SET approver_role = 'treasurer' WHERE id = ${empty}`).rejects.toThrow(/never changes/);
    await expect(sql`UPDATE workspaces SET leaver_role = 'treasurer' WHERE id = ${empty}`).rejects.toThrow(/never changes/);
    await sql`UPDATE workspaces SET name = 'foundation fixture (renamed)' WHERE id = ${empty}`;
    expect((await getWorkspace(empty))?.name).toBe("foundation fixture (renamed)");
  });

  it("a workspace cannot be created without a pack id, or with the approver as the leaver", async () => {
    await expect(sql`INSERT INTO workspaces (name, kind) VALUES ('x', 'empty')`).rejects.toThrow(/null value/);
    await expect(sql`
      INSERT INTO workspaces (name, kind, pack_id, approver_role, leaver_role) VALUES ('x', 'empty', 'club', 'president', 'president')`,
    ).rejects.toThrow(/workspaces_roles_chk/);
  });

  it("a workspace whose pack file is gone fails with a plain message", async () => {
    const [w] = await sql`
      INSERT INTO workspaces (name, kind, pack_id, approver_role, leaver_role) VALUES ('gone', 'empty', 'no-such-pack', 'boss', 'goer') RETURNING id`;
    try {
      await expect(getWorkspacePack(String(w.id))).rejects.toThrow("This workspace uses a setting that is no longer available.");
    } finally {
      await purge(String(w.id));
    }
  });
});

describe("the approver rule is enforced in the database without a role key", () => {
  it("refuses a snapshot approved by the leaver", async () => {
    await expect(sql`INSERT INTO snapshots ${sql(snapshotRow(empty, "snap_l", 1, CLUB.leaverRole))}`).rejects.toThrow(
      /the leaver can never approve a snapshot/,
    );
  });

  it("refuses a snapshot approved by any other role, of this pack or of another", async () => {
    for (const by of ["treasurer", CLUB.successorRole, "pi", "chair"]) {
      await expect(sql`INSERT INTO snapshots ${sql(snapshotRow(empty, `snap_${by}`, 1, by))}`).rejects.toThrow(
        /only the approver role of this workspace can approve a snapshot/,
      );
    }
  });

  it("accepts the workspace's approver, and follows the workspace, not a fixed key", async () => {
    await sql`INSERT INTO snapshots ${sql(snapshotRow(empty, "snap_ok", 1, CLUB.approverRole))}`;
    const [w] = await sql`
      INSERT INTO workspaces (name, kind, pack_id, approver_role, leaver_role) VALUES ('other setting', 'empty', 'garden', 'chair', 'old_keeper') RETURNING id`;
    const other = String(w.id);
    try {
      await sql`INSERT INTO snapshots ${sql(snapshotRow(other, "snap_ok", 1, "chair"))}`;
      await expect(sql`INSERT INTO snapshots ${sql(snapshotRow(other, "snap_p", 2, CLUB.approverRole))}`).rejects.toThrow(/only the approver role/);
      await expect(sql`INSERT INTO snapshots ${sql(snapshotRow(other, "snap_l", 3, "old_keeper"))}`).rejects.toThrow(/leaver can never approve/);
      // The update path is guarded too.
      await expect(sql`UPDATE snapshots SET approved_by = 'old_keeper' WHERE workspace_id = ${other}`).rejects.toThrow(/leaver can never approve/);
    } finally {
      await purge(other);
    }
  });
});

describe("role holders", () => {
  it("are filled from the pack when the demo workspace is created", async () => {
    const holders = await listRoleHolders(ws);
    const names = (role: string) => [...new Set(holders.filter((h) => h.roleKey === role).map((h) => h.displayName))];
    expect(names("president")).toEqual(["Rohan Mehta"]);
    expect(names("tech_lead")).toEqual(["Arjun Rao"]);
    expect(names("treasurer")).toEqual(["Ananya Iyer"]);
    expect(names("leaver")).toEqual(["Priya Nair"]);
    expect(names("new_member")).toEqual([]);
    expect(holders.every((h) => h.source === "pack")).toBe(true);
    // One human can have several person records (a chat export and a code host): every one is listed.
    expect(holders.filter((h) => h.roleKey === "president").length).toBeGreaterThanOrEqual(2);
  });

  it("people with no role in the handover are not holders", async () => {
    const holders = await listRoleHolders(ws);
    const [kabir] = await sql`SELECT id FROM people WHERE workspace_id = ${ws} AND display_name = 'Kabir Sethi' LIMIT 1`;
    expect(kabir).toBeTruthy();
    expect(holders.some((h) => h.personId === String(kabir.id))).toBe(false);
  });

  it("ensureRoleHolders is idempotent and indexes both ways", async () => {
    const [{ n: before }] = await sql`SELECT count(*)::int AS n FROM role_holders WHERE workspace_id = ${ws}`;
    const index = await ensureRoleHolders(ws);
    const [{ n: after }] = await sql`SELECT count(*)::int AS n FROM role_holders WHERE workspace_id = ${ws}`;
    expect(after).toBe(before);
    const leaverIds = index.byRole.get("leaver") ?? [];
    expect(leaverIds.length).toBeGreaterThan(0);
    expect(index.byPerson.get(leaverIds[0])).toEqual(["leaver"]);
    expect(index.byRole.has("new_member")).toBe(false);
  });

  it("an empty workspace has no holders until sources bring people", async () => {
    expect(await listRoleHolders(empty)).toEqual([]);
  });
});

describe("verify() keeps what Attest did not derive from the record", () => {
  const TS = "2026-11-12T10:00:00.000Z";
  const prompts: string[] = [];
  const noClaims: ModelCall = async (o) => {
    prompts.push(o.user);
    return { ok: true, data: o.schema.parse({ claims: [] }), cached: false };
  };

  const personSegment = (id: string, sourceId: string, sourceKind: Segment["sourceKind"], kind: Segment["kind"], text: string): Segment => ({
    id, sourceId, sourceKind, kind, ts: TS, authorId: null, thread: `${kind}:R01:rollback`, position: 0, text,
    textHash: sha256Hex(text), roleSet: [...CLUB.roleOrder], version: 1, meta: {},
  });

  const carried = (id: string, origin: ClaimOrigin, trust: Trust, segmentId: string, value: string): Claim => ({
    id, workspaceId: ws, entity: "firmware-rollback", entityLabel: "Firmware rollback", attribute: "procedure", value,
    statement: `Someone said: ${value}`, citations: [{ segmentId, quote: value, accepted: true, exact: true }], trust,
    state: "active", stateNote: null, supersededBy: null, roleSet: [...CLUB.roleOrder], validFrom: TS, authorId: null,
    sourceKinds: [origin === "successor_finding" ? "finding" : "interview"], importance: "blocking", tier: "C", review: "pending",
    reviewNote: null, origin, supportCheck: null,
  });

  const ANSWER = "Roll back with make flash-prev, then power-cycle. ANSWER-ONLY-TEXT";
  const FINDING = "Answer: the known-good build is tagged v2.3.1. FINDING-ONLY-TEXT";
  const claims = [
    carried("clm_keep_leaver", "leaver_answer", "leaver_said", "seg_fnd_answer0001", ANSWER),
    carried("clm_keep_neighbour", "neighbour_answer", "second_hand", "seg_fnd_answer0001", "I think it is make flash-prev"),
    carried("clm_keep_trace", "trace", "inferred", "seg_fnd_answer0001", "flash.sh runs before every release tag"),
    carried("clm_keep_finding", "successor_finding", "successor_found", "seg_fnd_finding001", FINDING),
  ];
  const stale: Claim = { ...carried("clm_stale_record", "extracted", "from_record", "seg_fnd_answer0001", "an old extracted claim"), tier: "B", importance: "normal" };

  beforeAll(async () => {
    // First run: structured claims only (the fake model returns nothing).
    await reconstruct(ws, { call: noClaims });
    await verify(ws, { support: false });

    // What other modules write between runs: a leaver answer, a successor finding, and their claims.
    await sql`
      INSERT INTO sources (workspace_id, id, kind, name, role_set, origin) VALUES
        (${ws}, 'src_interview', 'interview', 'Gap interview', ${CLUB.roleOrder}::text[], 'interview'),
        (${ws}, 'src_findings', 'finding', 'First weeks', ${CLUB.roleOrder}::text[], 'finding')`;
    const segs = [
      personSegment("seg_fnd_answer0001", "src_interview", "interview", "answer", ANSWER),
      personSegment("seg_fnd_finding001", "src_findings", "finding", "finding", FINDING),
    ];
    await sql`INSERT INTO segments ${sql(segs.map((s) => segmentRow(s, ws)))}`;
    // The fixtures above are built before the workspace exists: the id is filled in here.
    await sql`INSERT INTO claims ${sql([...claims, stale].map((c) =>
      claimRow({ ...c, workspaceId: ws }, [c.origin === "successor_finding" ? "src_findings" : "src_interview"])))}`;

    // Second run: "Run Understudy" again.
    prompts.length = 0;
    await reconstruct(ws, { call: noClaims });
    await verify(ws, { support: false });
  }, 120_000);

  const read = async (id: string) => {
    const [row] = await sql`SELECT * FROM claims WHERE workspace_id = ${ws} AND id = ${id}`;
    return row ? toClaim(row) : null;
  };

  it("the database accepts the new source kind, segment kind, trust and origins", async () => {
    const rows = await sql`SELECT origin, trust FROM claims WHERE workspace_id = ${ws} AND id LIKE 'clm_keep_%' ORDER BY id`;
    expect(rows.map((r) => `${r.origin}/${r.trust}`)).toEqual([
      "successor_finding/successor_found", "leaver_answer/leaver_said", "neighbour_answer/second_hand", "trace/inferred",
    ]);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM segments WHERE workspace_id = ${ws} AND kind = 'finding'`;
    expect(n).toBe(1);
    await expect(sql`UPDATE claims SET origin = 'made_up' WHERE workspace_id = ${ws} AND id = 'clm_keep_trace'`).rejects.toThrow(/claims_origin_check/);
    await expect(sql`UPDATE claims SET trust = 'verified' WHERE workspace_id = ${ws} AND id = 'clm_keep_trace'`).rejects.toThrow(/claims_trust_check/);
  });

  it("a re-run keeps a leaver answer, a neighbour answer, a trace and a successor finding", async () => {
    for (const c of claims) {
      const now = await read(c.id);
      expect(now, c.id).not.toBeNull();
      expect(now!.state, c.id).not.toBe("dropped");
      expect(now!.origin).toBe(c.origin);
      expect(now!.trust).toBe(c.trust);
      expect(now!.value).toBe(c.value);
      expect(now!.stateNote ?? "").not.toMatch(/latest extraction no longer finds/);
    }
  });

  it("a second-hand answer and a trace are not touched at all: they stay outside the rules", async () => {
    for (const id of ["clm_keep_neighbour", "clm_keep_trace"]) {
      const before = claims.find((c) => c.id === id)!;
      const now = (await read(id))!;
      expect(now).toMatchObject({ state: "active", stateNote: null, supersededBy: null, tier: before.tier, importance: before.importance });
      const events = await sql`SELECT event FROM claim_events WHERE workspace_id = ${ws} AND claim_id = ${id}`;
      expect(events).toEqual([]);
    }
  });

  it("a record claim the extraction no longer produces is still dropped (never deleted)", async () => {
    const now = (await read("clm_stale_record"))!;
    expect(now.state).toBe("dropped");
    expect(now.stateNote).toMatch(/latest extraction no longer finds this claim/);
  });

  it("no extraction prompt contained the answer or the finding, and no record claim cites them", async () => {
    expect(prompts.length).toBeGreaterThan(10);
    const sent = prompts.join("\n");
    expect(sent).not.toContain("ANSWER-ONLY-TEXT");
    expect(sent).not.toContain("FINDING-ONLY-TEXT");
    expect(sent).not.toContain("seg_fnd_answer0001");
    expect(sent).not.toContain("seg_fnd_finding001");
    const rows = await sql`
      SELECT id FROM claims WHERE workspace_id = ${ws} AND origin IN ('extracted', 'structured') AND state <> 'dropped'
        AND (citations::text LIKE '%seg_fnd_answer0001%' OR citations::text LIKE '%seg_fnd_finding001%')`;
    expect(rows).toEqual([]);
  });

  it("a third run changes nothing for the carried claims", async () => {
    await reconstruct(ws, { call: noClaims });
    await verify(ws, { support: false });
    for (const c of claims) expect((await read(c.id))!.state, c.id).not.toBe("dropped");
  });
});
