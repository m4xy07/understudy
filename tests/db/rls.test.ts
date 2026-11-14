// RLS is the compile boundary (docs/ARCHITECTURE.md section 5). Uses a tiny fixture workspace.
// Needs a migrated database: pnpm db:up && pnpm db:migrate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { withRole } from "@/lib/db/withRole";
import { countWithheld, getSegment, listClaims } from "@/lib/db/queries";

const sql = db();
let ws = "";

const ALL = ["president", "tech_lead", "new_member", "treasurer", "leaver"];
const FINANCE = ["president", "treasurer"];

beforeAll(async () => {
  const [w] = await sql`INSERT INTO workspaces (name, kind, pack_id, approver_role, leaver_role) VALUES ('rls fixture', 'empty', 'club', 'president', 'leaver') RETURNING id`;
  ws = String(w.id);
  await sql`INSERT INTO sources (workspace_id, id, kind, name, role_set) VALUES
    (${ws}, 'src_board', 'tasks_csv', 'board.csv', ${ALL}::text[]),
    (${ws}, 'src_fin', 'markdown', 'finance.md', ${FINANCE}::text[])`;
  await sql`INSERT INTO segments (workspace_id, id, source_id, source_kind, kind, ts, thread, text, text_hash, role_set) VALUES
    (${ws}, 'seg_public', 'src_board', 'tasks_csv', 'task', now(), 'board', 'Book the lab for term 2', 'h1', ${ALL}::text[]),
    (${ws}, 'seg_finance', 'src_fin', 'markdown', 'note', now(), 'finance.md', 'Sponsor account PIN owner: treasurer CANARY-7Q2F', 'h2', ${FINANCE}::text[])`;
  await sql`INSERT INTO claims (workspace_id, id, entity, entity_label, attribute, value, statement, trust, role_set, valid_from, origin) VALUES
    (${ws}, 'clm_public', 'lab-booking', 'Lab booking', 'owner', 'Priya', 'Priya books the lab.', 'from_record', ${ALL}::text[], now(), 'structured'),
    (${ws}, 'clm_finance', 'sponsor-account', 'Sponsor account', 'access', 'treasurer', 'The treasurer holds the sponsor account PIN.', 'from_record', ${FINANCE}::text[], now(), 'extracted')`;
  await sql`INSERT INTO snapshots (workspace_id, id, version, hash, approved_by, payload)
    VALUES (${ws}, 'snap_v1', 1, 'abc', 'president', '{}'::jsonb)`;
  await sql`INSERT INTO snapshot_claims (workspace_id, snapshot_id, claim_id, entity, attribute, statement, trust, role_set) VALUES
    (${ws}, 'snap_v1', 'clm_public', 'lab-booking', 'owner', 'Priya books the lab.', 'from_record', ${ALL}::text[]),
    (${ws}, 'snap_v1', 'clm_finance', 'sponsor-account', 'access', 'The treasurer holds the sponsor account PIN.', 'from_record', ${FINANCE}::text[])`;
});

afterAll(async () => {
  if (ws) {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('us.allow_purge', 'on', true)`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
    });
  }
  await sql.end();
});

describe("withRole + RLS", () => {
  it("new_member cannot read a finance-only segment or claim", async () => {
    expect(await getSegment(ws, "seg_finance", "new_member")).toBeNull();
    const claims = await listClaims(ws, { role: "new_member" });
    expect(claims.map((c) => c.id)).toEqual(["clm_public"]);
    const raw = await withRole(ws, "new_member", (tx) => tx`SELECT text FROM segments WHERE workspace_id = ${ws}`);
    expect(raw.map((r) => r.text).join(" ")).not.toContain("CANARY-7Q2F");
  });

  it("president can read both", async () => {
    const seg = await getSegment(ws, "seg_finance", "president");
    expect(seg?.segment.text).toContain("CANARY-7Q2F");
    expect(seg?.sourceName).toBe("finance.md");
    const claims = await listClaims(ws, { role: "president" });
    expect(claims.map((c) => c.id).sort()).toEqual(["clm_finance", "clm_public"]);
  });

  it("rows of another workspace are invisible even with a matching role", async () => {
    const other = "00000000-0000-4000-8000-000000000000";
    const rows = await withRole(other, "president", (tx) => tx`SELECT id FROM claims WHERE workspace_id = ${ws}`);
    expect(rows.length).toBe(0);
  });

  it("count_withheld returns only the right integer", async () => {
    expect(await countWithheld(ws, "new_member")).toBe(1);
    expect(await countWithheld(ws, "tech_lead", "all")).toBe(1);
    expect(await countWithheld(ws, "tech_lead", "owner")).toBe(0);
    expect(await countWithheld(ws, "tech_lead", "access")).toBe(1);
    expect(await countWithheld(ws, "president")).toBe(0);
    expect(await countWithheld(ws, "treasurer")).toBe(0);
  });

  it("us_reader cannot write", async () => {
    await expect(
      withRole(ws, "president", (tx) => tx`UPDATE claims SET statement = 'x' WHERE workspace_id = ${ws}`),
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
    await sql`INSERT INTO acknowledgements (workspace_id, snapshot_id, snapshot_hash, role) VALUES (${ws}, 'snap_v1', 'abc', 'tech_lead')`;
    await expect(sql`UPDATE acknowledgements SET role = 'x' WHERE workspace_id = ${ws}`).rejects.toThrow(/append-only/);
  });

  it("segments are immutable", async () => {
    await expect(sql`UPDATE segments SET text = 'x' WHERE workspace_id = ${ws}`).rejects.toThrow(/immutable/);
  });
});
