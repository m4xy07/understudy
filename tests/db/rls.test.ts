// RLS is the compile boundary (docs/ARCHITECTURE.md section 5). Uses a tiny fixture workspace.
// Needs a migrated database: pnpm db:up && pnpm db:migrate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { countWithheld, getSegment, listClaims } from "@/lib/db/queries";

import { getPack, listDemoPacks } from "@/lib/pack";

const sql = db();

// The same suite runs once per pack in packs/index.json: the policies know no role key, so a
// new setting is one more row here, never a migration. Role jobs come from the pack's flags.
const PACKS = listDemoPacks().map((p) => {
  const pack = getPack(p.id);
  const special = new Set([pack.approverRole, pack.successorRole, pack.leaverRole, ...pack.restrictedAudienceRoles]);
  const other = pack.roleOrder.find((r) => !special.has(r));
  if (!other) throw new Error(`pack ${p.id}: the RLS suite needs one role with no flag`);
  return {
    id: p.id,
    all: pack.roleOrder,
    approver: pack.approverRole,
    successor: pack.successorRole,
    leaver: pack.leaverRole,
    least: pack.restrictedAudienceRoles[0],   // the role that sees least
    other,                                    // a plain role: here it shares the narrow source with the approver
    narrow: [pack.approverRole, other],
  };
});

describe.each(PACKS)("RLS with the role keys of pack $id", (P) => {
let ws = "";

beforeAll(async () => {
  const [w] = await sql`INSERT INTO workspaces (name, kind, pack_id, approver_role, leaver_role) VALUES ('rls fixture', 'empty', ${P.id}, ${P.approver}, ${P.leaver}) RETURNING id`;
  ws = String(w.id);
  await sql`INSERT INTO sources (workspace_id, id, kind, name, role_set) VALUES
    (${ws}, 'src_board', 'tasks_csv', 'board.csv', ${P.all}::text[]),
    (${ws}, 'src_fin', 'markdown', 'finance.md', ${P.narrow}::text[])`;
  await sql`INSERT INTO segments (workspace_id, id, source_id, source_kind, kind, ts, thread, text, text_hash, role_set) VALUES
    (${ws}, 'seg_public', 'src_board', 'tasks_csv', 'task', now(), 'board', 'Book the room for term 2', 'h1', ${P.all}::text[]),
    (${ws}, 'seg_finance', 'src_fin', 'markdown', 'note', now(), 'finance.md', 'Account PIN owner: the finance holder CANARY-7Q2F', 'h2', ${P.narrow}::text[])`;
  await sql`INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, trust, role_set, valid_from, origin) VALUES
    (${ws}, 'clm_public', 'room-booking', 'Room booking', 'owner', 'Sam', 'Sam books the room.', 'from_record', ${P.all}::text[], now(), 'structured'),
    (${ws}, 'clm_finance', 'bank-account', 'Bank account', 'access', 'finance holder', 'The finance holder keeps the account PIN.', 'from_record', ${P.narrow}::text[], now(), 'extracted')`;
  await sql`INSERT INTO snapshots (workspace_id, id, version, hash, approved_by, payload)
    VALUES (${ws}, 'snap_v1', 1, 'abc', ${P.approver}, '{}'::jsonb)`;
  await sql`INSERT INTO snapshot_claims (workspace_id, snapshot_id, claim_id, entity, attribute, statement, trust, role_set) VALUES
    (${ws}, 'snap_v1', 'clm_public', 'room-booking', 'owner', 'Sam books the room.', 'from_record', ${P.all}::text[]),
    (${ws}, 'snap_v1', 'clm_finance', 'bank-account', 'access', 'The finance holder keeps the account PIN.', 'from_record', ${P.narrow}::text[])`;
});

afterAll(async () => {
  if (ws) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
});

describe("withRole + RLS", () => {
  it("the restricted audience role cannot read a narrow segment or claim", async () => {
    expect(await getSegment(ws, "seg_finance", P.least)).toBeNull();
    const claims = await listClaims(ws, { role: P.least });
    expect(claims.map((c) => c.id)).toEqual(["clm_public"]);
    const raw = await withRole(ws, P.least, (tx) => tx`SELECT text FROM segments WHERE workspace_id = ${ws}`);
    expect(raw.map((r) => r.text).join(" ")).not.toContain("CANARY-7Q2F");
    const snap = await withRole(ws, P.least, (tx) => tx`SELECT claim_id FROM snapshot_claims WHERE workspace_id = ${ws}`);
    expect(snap.map((r) => r.claim_id)).toEqual(["clm_public"]);
  });

  it("the approver can read both", async () => {
    const seg = await getSegment(ws, "seg_finance", P.approver);
    expect(seg?.segment.text).toContain("CANARY-7Q2F");
    expect(seg?.sourceName).toBe("finance.md");
    const claims = await listClaims(ws, { role: P.approver });
    expect(claims.map((c) => c.id).sort()).toEqual(["clm_finance", "clm_public"]);
  });

  it("a role key of another pack, or of no pack, reads nothing", async () => {
    const foreign = PACKS.flatMap((x) => x.all).filter((r) => !P.all.includes(r));
    for (const role of [...foreign, "nobody_role"]) {
      const rows = await withRole(ws, role, (tx) => tx`SELECT id FROM claims WHERE workspace_id = ${ws}`);
      expect(rows.length, role).toBe(0);
      const segs = await withRole(ws, role, (tx) => tx`SELECT id FROM segments WHERE workspace_id = ${ws}`);
      expect(segs.length, role).toBe(0);
    }
  });

  it("rows of another workspace are invisible even with a matching role", async () => {
    const other = "00000000-0000-4000-8000-000000000000";
    const rows = await withRole(other, P.approver, (tx) => tx`SELECT id FROM claims WHERE workspace_id = ${ws}`);
    expect(rows.length).toBe(0);
  });

  it("count_withheld returns only the right integer", async () => {
    expect(await countWithheld(ws, P.least)).toBe(1);
    expect(await countWithheld(ws, P.successor, "all")).toBe(1);
    expect(await countWithheld(ws, P.successor, "owner")).toBe(0);
    expect(await countWithheld(ws, P.successor, "access")).toBe(1);
    expect(await countWithheld(ws, P.approver)).toBe(0);
    expect(await countWithheld(ws, P.other)).toBe(0);
  });

  it("the database lets only the workspace's approver approve a snapshot", async () => {
    const insert = (by: string, v: number) => sql`INSERT INTO snapshots (workspace_id, id, version, hash, approved_by, payload)
      VALUES (${ws}, ${"snap_x" + v}, ${v}, 'x', ${by}, '{}'::jsonb)`;
    await expect(insert(P.leaver, 2)).rejects.toThrow();
    await expect(insert(P.successor, 3)).rejects.toThrow();
    const foreignApprover = PACKS.map((x) => x.approver).find((r) => r !== P.approver);
    if (foreignApprover) await expect(insert(foreignApprover, 4)).rejects.toThrow();
  });

  it("us_reader cannot write", async () => {
    await expect(
      withRole(ws, P.approver, (tx) => tx`UPDATE claims SET statement = 'x' WHERE workspace_id = ${ws}`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("the app user still does admin reads and writes", async () => {
    const all = await sql`SELECT id FROM claims WHERE workspace_id = ${ws}`;
    expect(all.length).toBe(2);
    await sql`UPDATE claims SET review = 'approved' WHERE workspace_id = ${ws} AND id = 'clm_finance'`;
    const [c] = await sql`SELECT review FROM claims WHERE workspace_id = ${ws} AND id = 'clm_finance'`;
    expect(c.review).toBe("approved");
  });
});

describe("append-only and immutable tables", () => {
  it("claim_events rejects UPDATE and DELETE", async () => {
    await sql`INSERT INTO claim_events (workspace_id, claim_id, event) VALUES (${ws}, 'clm_public', 'created')`;
    await expect(sql`UPDATE claim_events SET event = 'x' WHERE workspace_id = ${ws}`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM claim_events WHERE workspace_id = ${ws}`).rejects.toThrow(/append-only/);
  });

  it("audit_log and acknowledgements reject UPDATE", async () => {
    await sql`INSERT INTO audit_log (workspace_id, actor, action) VALUES (${ws}, 'system', 'test')`;
    await expect(sql`UPDATE audit_log SET action = 'x' WHERE workspace_id = ${ws}`).rejects.toThrow(/append-only/);
    await sql`INSERT INTO acknowledgements (workspace_id, snapshot_id, snapshot_hash, role) VALUES (${ws}, 'snap_v1', 'abc', ${P.successor})`;
    await expect(sql`UPDATE acknowledgements SET role = 'x' WHERE workspace_id = ${ws}`).rejects.toThrow(/append-only/);
  });

  it("segments are immutable", async () => {
    await expect(sql`UPDATE segments SET text = 'x' WHERE workspace_id = ${ws}`).rejects.toThrow(/immutable/);
  });
});
});

afterAll(async () => {
  await sql.end();
});
